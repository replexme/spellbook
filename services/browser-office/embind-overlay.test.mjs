import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { applyEmbindOverlay } from "./embind-overlay.mjs";

// The finalizer as Emscripten 3.1.65 emits it with ASSERTIONS=1, inside the
// declarations it refers to.
const assertingFinalizer =
  "attachFinalizer=handle=>{var $$=handle.$$;var hasSmartPtr=!!$$.smartPtr;" +
  "if(hasSmartPtr){var info={$$:$$};var cls=$$.ptrType.registeredClass;" +
  "var err=new Error(`Embind found a leaked C++ instance ${cls.name} <${ptrToString($$.ptr)}>.\\n`+" +
  '"We\'ll free it automatically in this case, but this functionality is not reliable across various environments.\\n"+' +
  '"Make sure to invoke .delete() manually once you\'re done with the instance instead.\\n"+' +
  '"Originally allocated");' +
  'if("captureStackTrace"in Error){Error.captureStackTrace(err,RegisteredPointer_fromWireType)}' +
  'info.leakWarning=err.stack.replace(/^Error: /,"");' +
  "finalizationRegistry.register(handle,info,handle)}return handle}";
const engine = (finalizer) =>
  "var registered=[];var finalizationRegistry={register:(target,info,token)=>registered.push(info)};" +
  "var ptrToString=ptr=>String(ptr);function RegisteredPointer_fromWireType(){}" +
  `var attachFinalizer;${finalizer};` +
  "attachFinalizer({$$:{smartPtr:1,ptr:8,ptrType:{registeredClass:{name:'X'}}}});" +
  "attachFinalizer({$$:{ptr:9,ptrType:{registeredClass:{name:'Y'}}}});" +
  "registered";

test("the Embind overlay keeps the cleanup registration and drops the leak warning", () => {
  const patched = applyEmbindOverlay(engine(assertingFinalizer));
  assert.doesNotMatch(patched, /leaked C\+\+ instance|captureStackTrace/u);
  const registered = vm.runInNewContext(patched);
  // Only the smart pointer is registered, with the object to release.
  assert.equal(registered.length, 1);
  assert.equal(registered[0].$$.ptr, 8);
  assert.equal("leakWarning" in registered[0], false);
});

test("the Embind overlay refuses a changed or already patched engine", () => {
  const patched = applyEmbindOverlay(engine(assertingFinalizer));
  assert.throws(() => applyEmbindOverlay(patched), /already carries/u);
  assert.throws(
    () =>
      applyEmbindOverlay(
        engine(assertingFinalizer.replace("new Error", "new TypeError")),
      ),
    /drifted/u,
  );
  assert.throws(
    () =>
      applyEmbindOverlay(engine(assertingFinalizer + ";" + assertingFinalizer)),
    /drifted/u,
  );
});
