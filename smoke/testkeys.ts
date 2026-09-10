// Throwaway keypairs for the offline test suites.
//
// These sign nothing that touches a real chain - the suites use synthetic
// hashchain seeds - so the keys are disposable and generated on demand. Doing
// it here rather than depending on files that happen to exist locally is what
// lets the suites run on a clean checkout (CI included).

import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const SCRATCH = path.resolve(__dirname);

/** Load a keypair from `smoke/<name>.json`, creating it if absent. */
export function loadOrCreate(name: string): Keypair {
  const file = path.join(SCRATCH, `${name}.json`);
  if (fs.existsSync(file)) {
    return Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(file, "utf-8")))
    );
  }
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

/** Path the CLI should be pointed at with --keypair. */
export function keyPath(name: string): string {
  loadOrCreate(name);
  return path.join(SCRATCH, `${name}.json`);
}
