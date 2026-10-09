# Spellbook Symbols

This OFL-1.1 face uses seven glyph outlines from the pinned Noto Sans Symbols 2
source. Its glyph advance and bounds match independently measured legacy symbol
metrics. No Microsoft font bytes or outlines are included. The family is renamed
and the modifications are declared in the font notice and served font permissions.

Run `python3 build-font.py` with FontTools 4.60.1. The original Noto TTF, its OFL
notice, exact download receipt, numeric recipe, and builder are included here.
The resulting SHA must match `native-font-info.json`. That file records the
actual admitted ONLYOFFICE FreeType face inspection and engine hashes.

The shared workspace server adds this public program font to both the browser
and converter catalogs. The native SDK maps only a single, explicit legacy
bullet character when its authored family is unavailable. Embedded original
families retain priority; other characters, inherited fonts and authored OOXML
remain unchanged. Width and paint use the native font engine.

The seven reviewed codes cover active legacy bullets in the current 203-input
corpus. This does not establish arbitrary legacy symbol or mathematical text
coverage, or complete PowerPoint layout equivalence.
