/* SPDX-License-Identifier: MPL-2.0 */
// The pinned SerializeWriter.js boundary used by run/bullet effect tests.
export class PinnedNativeWriterFixture {
  constructor() {
    this.records = [];
    this.integerRecords = [];
    this._WriteInt1 = (type, value) => this.integerRecords.push({type, value});
    this._WriteInt4 = (type, value, scale) => {
      if (value != null) this._WriteInt1(type, (value * scale) >> 0);
    };
    this.WriteXfrm = this.WriteXfrmRot = (xfrm) => {
      for (const [type, name] of ['offX','offY','extX','extY','chOffX','chOffY','chExtX','chExtY'].entries())
        this._WriteInt4(type, xfrm[name], 36000);
      if (xfrm.fail) throw xfrm.fail;
      this._WriteInt4(10, xfrm.rot, 180 * 60000 / Math.PI);
    };
    this.WriteRunProperties = (pr) => { this.written = pr; };
    this.WriteRecord1 = (type, value, write) => { this.records.push({type, value}); write(value); };
    this.WriteEffectLst = (value) => { this.effects = value; };
  }
}
