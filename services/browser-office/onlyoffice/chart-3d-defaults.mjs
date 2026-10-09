/* SPDX-License-Identifier: AGPL-3.0-only */
// Native PowerPoint controls show that omitted bar-chart rotation is 15/20;
// explicit 0/0 remains flat. Only the derived view copy receives defaults.
export function installOnlyOfficeChart3dDefaults() {
  const key = Symbol.for('spellbook.onlyoffice.chart3dDefaults/v1');
  if (window[key]) return;
  const prototype = AscFormat.CChart?.prototype;
  const original = prototype?.getView3d;
  if (typeof original !== 'function' || typeof AscFormat.isRealNumber !== 'function' || !Number.isInteger(AscDFH.historyitem_type_BarChart))
    throw Error('onlyoffice_chart3d_native_boundary_missing');
  prototype.getView3d = function (...args) {
    const view = original.apply(this, args);
    const chart = this.plotArea?.charts?.[0];
    if (!view || !this.view3D || chart?.b3D !== true || chart.getObjectType?.() !== AscDFH.historyitem_type_BarChart) return view;
    if (!AscFormat.isRealNumber(this.view3D.rotX)) view.rotX = 15;
    if (!AscFormat.isRealNumber(this.view3D.rotY)) view.rotY = 20;
    return view;
  };
  window[key] = true;
}
