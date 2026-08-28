import { RustClient } from "./rust-bridge.js";

async function main() {
  const client = new RustClient();
  client.start();

  try {
    console.log("Testing sliceAst...");
    const code = `
function foo() {
  console.log("This is foo");
}
class Bar {}
    `;
    const slice = await client.sliceAst(code, ["foo"]);
    console.log("sliceAst result:", slice);

    console.log("Testing computeDiff...");
    const diff = await client.computeDiff("a", "b");
    console.log("computeDiff result:", diff);

    console.log("Testing checkCycle...");
    const hash = new Array(32).fill(0);
    hash[0] = 1;
    hash[1] = 2;
    hash[2] = 3;
    const cycle1 = await client.checkCycle(hash, "ls");
    console.log("checkCycle 1 result:", cycle1);

    const cycle2 = await client.checkCycle(hash, "ls");
    console.log("checkCycle 2 result (should be cycle):", cycle2);
  } catch (e) {
    console.error("Error:", e);
  } finally {
    client.stop();
  }
}

main();
