// SPDX-License-Identifier: MPL-2.0

// LibreOffice links the browser engine with Emscripten ASSERTIONS=1 (to keep
// the final link from rewriting the module), and in that mode Embind builds a
// "leaked C++ instance" warning for every C++ object it hands to JavaScript:
// an Error with a captured stack, kept in case the object is never deleted.
// ZetaJS deletes the objects it receives itself, so the warning is never
// shown, yet building it was most of the cost of every document read: a
// 14-slide deck read in 24.6 s with it and 3.1 s without, and one fill-colour
// edit took 139-158 s instead of 6.5 s. The overlay keeps Embind's cleanup
// registration and drops only the warning, which is what the same Embind code
// emits without ASSERTIONS.
const leakWarningFinalizer =
  "attachFinalizer=handle=>{var $$=handle.$$;var hasSmartPtr=!!$$.smartPtr;" +
  "if(hasSmartPtr){var info={$$:$$};var cls=$$.ptrType.registeredClass;" +
  "var err=new Error(`Embind found a leaked C++ instance ${cls.name} <${ptrToString($$.ptr)}>.\\n`+" +
  '"We\'ll free it automatically in this case, but this functionality is not reliable across various environments.\\n"+' +
  '"Make sure to invoke .delete() manually once you\'re done with the instance instead.\\n"+' +
  '"Originally allocated");' +
  'if("captureStackTrace"in Error){Error.captureStackTrace(err,RegisteredPointer_fromWireType)}' +
  'info.leakWarning=err.stack.replace(/^Error: /,"");' +
  "finalizationRegistry.register(handle,info,handle)}return handle}";

const releaseFinalizer =
  "attachFinalizer=handle=>{var $$=handle.$$;var hasSmartPtr=!!$$.smartPtr;" +
  "if(hasSmartPtr){var info={$$:$$};" +
  "finalizationRegistry.register(handle,info,handle)}return handle}";

export function applyEmbindOverlay(source) {
  if (typeof source !== "string")
    throw new TypeError("The engine's JavaScript must be text.");
  if (source.includes(releaseFinalizer))
    throw new Error("The engine already carries the Embind overlay.");
  const first = source.indexOf(leakWarningFinalizer);
  if (first < 0 || source.indexOf(leakWarningFinalizer, first + 1) >= 0)
    throw new Error("The engine's Embind finalizer has drifted.");
  // A function replacement: the text's `$$` must not read as a pattern.
  return source.replace(leakWarningFinalizer, () => releaseFinalizer);
}
