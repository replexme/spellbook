/* SPDX-License-Identifier: MPL-2.0 */

/** Reference captures explicitly bind the clock; ordinary rendering uses live time. */
export function presentationReferenceEpoch(referenceDateTime = null) {
  if (referenceDateTime === null) return null;
  if (
    typeof referenceDateTime !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(referenceDateTime)
  ) throw Error('onlyoffice_reference_date_time_invalid');
  const epoch = Date.parse(referenceDateTime);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0,19) !== referenceDateTime.slice(0,19))
    throw Error('onlyoffice_reference_date_time_invalid');
  return epoch;
}

// Serialized into each verification frame. Timers and Date.now continue normally.
export function installPresentationReferenceDate(epoch) {
  const NativeDate = globalThis.Date;
  globalThis.Date = new Proxy(NativeDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length ? args : [epoch], newTarget);
    },
    apply() { return new NativeDate(epoch).toString(); },
  });
}
