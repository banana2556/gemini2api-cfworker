# Worker resource limits repair

User approved the resource fixes identified in the architecture review. Production
uses Workers Free and fails on `/v1/chat/completions`; no invocation logs are
available, so local checks cannot establish the production CPU/memory outcome.

## Design and implementation plan

Keep the single-file Worker and existing transport preference/API formats.
Use native streams and bounded buffers, with no runtime dependencies.

- [x] Add failing regression tests in `test/resource-limits.test.mjs` for
  fragmented HTTP chunks, slow readers/cancellation, oversized inputs and
  generation without whole-response buffering.
- [x] Change `worker.js` socket decoding to emit partial HTTP chunks on demand,
  bound framing metadata, and clean up readers/sockets on failure or cancellation.
- [x] Share incremental line parsing between streaming and non-streaming
  generation. Decode each Gemini frame once for both text and route metadata;
  retain only the current frame and longest response, not the full wire history.
- [x] Await downstream SSE writes; propagate cancellation to upstream readers.
- [x] Bound request/image reads before allocation and Base64 decoding. Make
  `/health` independent of upstream page discovery.
- [x] Run `node --test`, review error/cancellation paths, and document deployment
  limits and compatibility tradeoffs in `README.md`.

Socket remains the default because native fetch may encounter Google egress 429s.
Tool calls and Responses API retain their existing final-result SSE format, but
their upstream input is consumed incrementally. Full Responses API event redesign
is outside this resource fix. Limits are finite implementation ceilings, not a
promise of fitting arbitrary concurrent traffic into Workers Free's CPU budget.


## Verification results

- `node --test`: 69 passing tests, including 18 resource regression tests.
- `npx --yes wrangler deploy --dry-run --outdir .wrangler/resource-check`:
  passed; no deployment performed.
- `git diff --check`: passed.
- Synthetic socket comparison: a 1 MiB HTTP chunk delivered in 16 KiB packets
  produced 35,127,358 bytes of `Uint8Array.set()` copying in HEAD, versus zero
  in the revised socket body path. Both produced 1,048,576 output bytes.
  This measures explicit buffer copying, not total allocations or deployed CPU.
- Read-only review findings addressed: discovery limit propagation and
  cancellation of cold discovery reads; both have regression coverage.
- Existing Node module-type warnings remain local test-runner warnings.

Production 503 resolution remains unverified until deployment and replay of the
failing conversation. No Cloudflare account settings were changed.
