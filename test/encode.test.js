import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData } from "viem";
import { ABI, FAROSWAP, TOKENS } from "../lib/contracts.js";
import { encodeMixSwap, minAfterSlippage } from "../lib/quote.js";
import { Injector, plain } from "../lib/engine.js";
import { fmt } from "../lib/steps.js";

test("mixSwap calldata matches the shape of real FaroSwap swaps (selector 0xff84aafa)", () => {
  const data = encodeMixSwap({ fromToken: TOKENS.WPROS.address, toToken: TOKENS.USDC.address, amount: 10n ** 18n, expReturn: 500000n, minReturn: 495000n, direction: 0, deadline: 1n });
  assert.equal(data.slice(0, 10), "0xff84aafa");
  const { args } = decodeFunctionData({ abi: ABI.routeProxy, data });
  assert.equal(args[0], TOKENS.WPROS.address);
  assert.equal(args[1], TOKENS.USDC.address);
  assert.deepEqual(args[5], [FAROSWAP.adapter]);
  assert.deepEqual(args[6], [FAROSWAP.pool]);
  assert.deepEqual(args[7], [FAROSWAP.adapter, FAROSWAP.routeProxy]);
  assert.equal(args[8], 0n);
  assert.equal(args[4], 495000n);
});

test("slippage guard is exact integer math", () => {
  assert.equal(minAfterSlippage(1_049_736n, 100), 1_039_238n);
  assert.equal(minAfterSlippage(1_000_000n, 0), 1_000_000n);
});

test("injector rules parse and fire once", () => {
  const inj = new Injector(Injector.parse(["drop@swap", "rpc@approve-wpros"]));
  assert.equal(inj.take("swap", "drop"), true);
  assert.equal(inj.take("swap", "drop"), false);
  assert.equal(inj.take("swap", "rpc"), false);
  assert.throws(() => Injector.parse(["boom@swap"]), /--inject must look like/);
});

test("log entries are plain JSON (bigints become strings)", () => {
  assert.deepEqual(plain({ a: 1n, b: [2n], c: { d: 3n } }), { a: "1", b: ["2"], c: { d: "3" } });
});

test("amount formatting keeps precision", () => {
  assert.equal(fmt.usdc(1574611n), "1.574611 USDC");
  assert.equal(fmt.pros(3n * 10n ** 18n), "3 PROS");
  assert.equal(fmt.wpros(6111000000000000n), "0.006111 WPROS");
});
