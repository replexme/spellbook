/* SPDX-License-Identifier: AGPL-3.0-only */
// Native SDK source patch for DrawingML's distributed paragraph alignment.
// The pinned reader currently merges dist and just; the writer then loses dist.
// Patch the native paragraph layout so drawing, selection and text editing share
// the same character positions. Never change the document's text or font size.
import { createHash } from "node:crypto";

const retainedSha256 =
  "d6566c9e9157c803b8012700c1cf74bd4eadfeb2ce036a23f092af8b2d2d6cc6";
const reader = "case 1:{para_pr.Jc=AscCommon.align_Justify;break}";
const writer =
  "case AscCommon.align_Justify:oThis._WriteUChar1(0,2);break;default:break";
const layoutStart =
  "Paragraph.prototype.private_RecalculateLineAlign=function(";
const layoutCase = "case AscCommon.align_Justify:{";
const spaceWidth =
  "if(PRS.IsBalanceSingleByteDoubleByteWidth(this,\nPos))Item.BalanceSingleByteDoubleByteWidth();";
const readApiAlignment = "function private_GetStrParaAlign(jc){switch(jc){";
const writeApiAlignment = "function private_GetInnerParaAlign(sJc){";
const alignState =
  "PRSA.JustifyWord=JustifyWord;PRSA.JustifySpace=JustifySpace;";
const letterWidth = "else WidthVisible=Item.GetWidth()+PRSA.JustifyWord;";
const distributedCase = `case AscCommon.align_Distributed:{
var distributedSlots=PRSC.Letters+PRSC.Spaces;
X=bRtlAlign?Range.X-rtlShift:Range.X;
if(bRtlAlign){
if(PRSC.Spaces>0){JustifySpace=Math.max(0,RangeWidth-Range.W)/PRSC.Spaces;}
else if(PRSC.Letters>0){X=Range.X+(RangeWidth-Range.W)/2-rtlShift;}
}
else if(!bRtlAlign && distributedSlots>1){
var distributedGap=Math.max(0,RangeWidth-Range.W)/(distributedSlots-1);
JustifyWord=distributedGap;JustifySpace=distributedGap;
}else if(distributedSlots===1){X=Range.X+(RangeWidth-Range.W)/2-(bRtlAlign?rtlShift:0);}
break}
`;
let cachedSource, cachedPatched;

export function patchOnlyOfficeDistributedAlignment(source) {
  if (source === cachedSource) return cachedPatched;
  if (createHash("sha256").update(source).digest("hex") !== retainedSha256)
    throw Error("onlyoffice_distributed_alignment_sdk_identity_mismatch");
  for (const anchor of [
    reader,
    writer,
    layoutStart,
    spaceWidth,
    readApiAlignment,
    writeApiAlignment,
    alignState,
    letterWidth,
  ])
    if (source.split(anchor).length !== 2)
      throw Error("onlyoffice_distributed_alignment_boundary_mismatch");
  let patched = source
    .replace(reader, "case 1:{para_pr.Jc=AscCommon.align_Distributed;break}")
    .replace(
      readApiAlignment,
      readApiAlignment +
        'case AscCommon.align_Distributed:return"distributed";',
    )
    .replace(
      writeApiAlignment,
      writeApiAlignment +
        'if(sJc==="distributed")return AscCommon.align_Distributed;',
    )
    .replace(
      alignState,
      alignState +
        "PRSA.spellbookDistributedLettersRemaining=jc===AscCommon.align_Distributed&&!bRtlAlign?PRSC.Letters:null;",
    )
    // Do not add tracking after the final character: the caret and hit region
    // must end at the same right edge as the drawn text.
    .replace(
      letterWidth,
      "else{WidthVisible=Item.GetWidth()+PRSA.JustifyWord;if(PRSA.spellbookDistributedLettersRemaining!==null&&PRSA.spellbookDistributedLettersRemaining!==undefined&&--PRSA.spellbookDistributedLettersRemaining===0)WidthVisible=Item.GetWidth();}",
    )
    .replace(
      writer,
      "case AscCommon.align_Distributed:oThis._WriteUChar1(0,1);break;" +
        writer,
    )
    // PowerPoint measures an ordinary space at half an em for Latin
    // distributed text. Apply it before wrapping as well as line alignment.
    // Flags store the native measured font size, including script/caps scaling.
    .replace(
      spaceWidth,
      "if(!Para.bFromDocument && ParaPr.Jc===AscCommon.align_Distributed && !ParaPr.Bidi && Item.Value===32){Item.Width=((Item.Flags>>>16)/64/2*g_dKoef_pt_to_mm*AscWord.TEXTWIDTH_DIVIDER)|0;}else " +
        spaceWidth,
    );
  const start = patched.indexOf(layoutStart),
    end = patched.indexOf("Paragraph.prototype.", start + layoutStart.length);
  const layout = patched.slice(start, end);
  if (end < 0 || layout.split(layoutCase).length !== 2)
    throw Error("onlyoffice_distributed_alignment_layout_mismatch");
  patched =
    patched.slice(0, start) +
    layout.replace(layoutCase, distributedCase + layoutCase) +
    patched.slice(end);
  cachedSource = source;
  cachedPatched = patched;
  return patched;
}
