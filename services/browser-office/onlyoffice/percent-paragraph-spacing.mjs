/* SPDX-License-Identifier: MPL-2.0 */
// Cached absolute spacing belongs to the last measured font/line metrics.
// Clear only that derived value before the SDK's next full two-pass reflow.
export function installOnlyOfficePercentParagraphSpacing(){
 const key=Symbol.for('spellbook.onlyoffice.percentParagraphSpacing/v1');
 if(window[key])return;
 const prototype=window.AscFormat?.CShape?.prototype,native=prototype?.recalculateDocContent;
 if(typeof native!=='function')throw Error('onlyoffice_percent_spacing_reflow_unavailable');
 prototype.recalculateDocContent=function(content,bodyPr,skipPercentageSpacing,...rest){
  if(!skipPercentageSpacing){
   for(const paragraph of content?.Content??[]){
    const spacing=paragraph.CompiledPr?.Pr?.ParaPr?.Spacing;
    if(!spacing)continue;
    if(Number.isFinite(spacing.BeforePct))spacing.Before=0;
    if(Number.isFinite(spacing.AfterPct))spacing.After=0;
   }
  }
  return native.call(this,content,bodyPr,skipPercentageSpacing,...rest);
 };
 window[key]=true;
}
