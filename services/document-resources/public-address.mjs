/* SPDX-License-Identifier: MPL-2.0 */
import ipaddr from "ipaddr.js";
/** Browser credentials and internal destinations cannot cross the public reader. */
export function isPublicAddress(address) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
