# SPDX-License-Identifier: MPL-2.0
"""Build the declared compatible OFL glyph face from pinned open outlines."""
import hashlib,json
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.ttLib import TTFont
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.recordingPen import DecomposingRecordingPen

w=Path(__file__).resolve().parent
source=w/'source/NotoSansSymbols2-Regular.ttf'
assert hashlib.sha256(source.read_bytes()).hexdigest()=='7d5fb73b7ca67a6798101741f5d280a3d016a56a197afcd4199dbb57b4b82a21'
recipe=json.loads((w/'font-recipe.json').read_text())
spec=recipe['glyphs']
font=TTFont(source);glyph_set=font.getGlyphSet();cmap=font.getBestCmap();glyphs={};hmtx={};mapping={};ledger=[]
for name in ['.notdef','space']:
    pen=TTGlyphPen(None);glyphs[name]=pen.glyph();hmtx[name]=(512,0)
for index,item in enumerate(spec):
    family,code,unicode=item['family'],item['code'],item['unicode'];dest=tuple(item['bounds']);advance=item['advance']
    origin=cmap[unicode];bounds=BoundsPen(glyph_set);glyph_set[origin].draw(bounds);b=bounds.bounds
    sx=(dest[2]-dest[0])/(b[2]-b[0]);sy=(dest[3]-dest[1])/(b[3]-b[1]);tx=dest[0]-b[0]*sx;ty=dest[1]-b[1]*sy
    name=f'compatible{index}';pen=TTGlyphPen(None);recording=DecomposingRecordingPen(glyph_set);glyph_set[origin].draw(recording);recording.replay(TransformPen(pen,(sx,0,0,sy,tx,ty)))
    glyph=pen.glyph();glyph.recalcBounds(None);glyphs[name]=glyph;hmtx[name]=(advance,dest[0]);mapping[item['targetCodePoint']]=name
    assert (glyph.xMin,glyph.yMin,glyph.xMax,glyph.yMax)==dest
    ledger.append({'family':family,'code':code,'unicode':unicode,'targetCodePoint':item['targetCodePoint'],'advance':advance,'bounds':dest,'transform':[sx,sy,tx,ty]})
fb=FontBuilder(2048,isTTF=True);fb.setupGlyphOrder(list(glyphs));fb.setupCharacterMap({32:'space',**mapping});fb.setupGlyf(glyphs);fb.setupHorizontalMetrics(hmtx);fb.setupHorizontalHeader(ascent=1841,descent=-432,lineGap=0)
ofl=(source.parent/'OFL.txt').read_text();family='Spellbook Symbols'
fb.setupNameTable({'familyName':family,'styleName':'Regular','fullName':family+' Regular','psName':'SpellbookSymbols-Regular','uniqueFontIdentifier':'Spellbook Symbols 1.000','version':'Version 1.000','copyright':'Copyright 2022 The Noto Project Authors; modifications Copyright 2026 Replex','licenseDescription':ofl,'licenseInfoURL':'https://openfontlicense.org/','typographicFamily':family,'typographicSubfamily':'Regular'})
fb.setupOS2(sTypoAscender=1841,sTypoDescender=-432,sTypoLineGap=0,usWinAscent=1841,usWinDescent=432,fsType=0,usWeightClass=400,usWidthClass=5,fsSelection=0x40)
fb.setupPost();fb.setupMaxp();fb.font['head'].created=fb.font['head'].modified=3786912000;fb.font.recalcTimestamp=False
file=w/'SpellbookSymbols-Regular.ttf';fb.save(file)
print(json.dumps({'file':str(file),'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'glyphs':len(ledger)}))
