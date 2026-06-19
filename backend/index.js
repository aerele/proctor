export { api } from "./src/handler.mjs";
// proctor-eval entry: the eval-only HTTP target. Deployed as a SEPARATE Cloud Run
// service (proctor-eval) via `functions-framework --target=evalApi`, sharing the
// same image + env + signer key as proctor-api (deploy isolation, not data
// isolation). proctor-api keeps using --target=api unchanged.
export { evalApi } from "./src/eval-server.mjs";
