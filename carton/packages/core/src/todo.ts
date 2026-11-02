// Stage-1 stubs: the signature is the contract, the body lands with its owner (see carton/CONTRACTS.md).
export function notImplemented(what: string): never {
  throw new Error(`not implemented: ${what}`);
}
