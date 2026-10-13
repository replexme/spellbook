# 가져온 DesignCraft 부품

출처: [storytold/designcraft](https://github.com/storytold/designcraft) 커밋 `4fbf8938bf922b29602ef6e6e0984a229a8b994a`(0.5.0). 라이선스는 `MIT OR Apache-2.0`이며 [LICENSE-MIT](LICENSE-MIT), [LICENSE-APACHE](LICENSE-APACHE), [NOTICE](NOTICE)를 그대로 둔다. ArtCraft 이름·로고는 상표이므로 쓰지 않는다. 번들 글꼴은 각 `assets/fonts/OFL-*.txt`의 SIL Open Font License 1.1을 따른다.

upstream을 계속 따라가지 않는다. 필요한 수정만 골라 가져오고, 바꾼 내용을 아래에 남긴다.

## designcraft-fonts

upstream `crates/fonts`(문자 모양 계산 HarfRust, 글꼴 해석 skrifa, 글꼴 DB·대체·외곽선)와 `assets/fonts`다. 외부 의존성 버전은 DesignCraft를 실측한 빌드의 `Cargo.lock`과 같게 고정했다. 가져온 직후 upstream 단위 테스트 46개가 통과했다.

수정 내역:
- `src/fontdb.rs`: 번들 글꼴 `include_bytes!` 경로 13곳을 `../../../assets/fonts/`에서 `../assets/fonts/`로 바꿨다(폴더 위치 변경).
- `src/tests_sysfonts.rs`: 시험 글꼴 경로를 같은 이유로 바꿨다.
- `Cargo.toml`: upstream 작업 공간 상속(`*.workspace = true`, `[lints]`)을 명시적인 값으로 바꿨다.
- `src/fontdb.rs`: `FontDb::open_scope` 추가(파일에 포함된 글꼴 바이트로 그 문서만 보는 글꼴 범위를 연다, PPTX 포함 글꼴용). 문서 범위 번호(`NEXT_SCOPE`)를 브라우저 빌드에서도 쓰도록 `#[cfg(not(target_arch = "wasm32"))]` 조건을 뺐다.

알려진 문제(실측·소스 확인, 아직 고치지 않음): 글꼴 DB가 프로세스 전역이고 `FaceRef::of`가 글꼴을 해제하지 않는다(`Box::leak`). 문서를 반복해 여는 서버 환경에서는 수정 대상이다.

| 파일 | upstream SHA-256 (앞 16자) | 상태 |
|---|---|---|
| `Cargo.toml` | `a864f4ad5531db0f` | modified |
| `assets/fonts/Inter-Medium.ttf` | `97ad806f526e4154` | unchanged |
| `assets/fonts/Inter-Regular.ttf` | `40d692fce188e447` | unchanged |
| `assets/fonts/Inter-SemiBold.ttf` | `78a843fade9d4612` | unchanged |
| `assets/fonts/JetBrainsMono-Regular.ttf` | `e6fd0d7e91550b3e` | unchanged |
| `assets/fonts/OFL-Inter.txt` | `262481e844521b32` | unchanged |
| `assets/fonts/OFL-JetBrainsMono.txt` | `a76abf002c49097d` | unchanged |
| `assets/fonts/OFL-SourceSans3.txt` | `56af9b9c6715597e` | unchanged |
| `assets/fonts/OFL-SourceSerif4.txt` | `c21d7293d87b6d7a` | unchanged |
| `assets/fonts/SourceSans3-Bold.ttf` | `9214b9d95e4231c6` | unchanged |
| `assets/fonts/SourceSans3-It.ttf` | `192afd78f0f54a3c` | unchanged |
| `assets/fonts/SourceSans3-Regular.ttf` | `4644c81b86ec9caa` | unchanged |
| `assets/fonts/SourceSans3-Semibold.ttf` | `a3f4f8dcf343a8f2` | unchanged |
| `assets/fonts/SourceSerif4-Bold.ttf` | `7cf4f4e1ad74f450` | unchanged |
| `assets/fonts/SourceSerif4-BoldIt.ttf` | `7b215b37f8873f55` | unchanged |
| `assets/fonts/SourceSerif4-It.ttf` | `9d2950a8f1da66e2` | unchanged |
| `assets/fonts/SourceSerif4-Regular.ttf` | `e5a4ee6a3d87bb90` | unchanged |
| `assets/fonts/SourceSerif4-Semibold.ttf` | `36db62940cb5728b` | unchanged |
| `build.rs` | `c2f6ec9cd788ec93` | unchanged |
| `src/fontdb.rs` | `c0284f3c8ddae992` | modified |
| `src/group.rs` | `bf41631fbca3f456` | unchanged |
| `src/lib.rs` | `23f1701c435f7997` | unchanged |
| `src/testing.rs` | `ac8412b534b27178` | unchanged |
| `src/tests_docfonts.rs` | `d35acd6467f0031e` | unchanged |
| `src/tests_fallback.rs` | `80a7983eb5c2e847` | unchanged |
| `src/tests_sysfonts.rs` | `8d358de1f40ed406` | modified |
| `src/tests_vertical.rs` | `6f15f5abafc83519` | unchanged |
| `src/vertical.rs` | `41b623d46eab49de` | unchanged |
| `tests/system_fonts.rs` | `b3f271afce1fe699` | unchanged |

## designcraft-geom, -color, -doc, -idml, -compose (2026-10-12)

InDesign(IDML) 지원용. 도형 기하, 색, 문서 모델, IDML 읽기·쓰기, 조판(문단 전체 줄바꿈, 하이픈, 양끝 정렬, 단, 연결 프레임, 감싸기)이다. `tools/vendor-designcraft.py`로 가져왔고, 파일마다 upstream 경로·SHA-256·상태를 각 폴더의 `PROVENANCE.json`에 남겼다(`python3 tools/vendor-designcraft.py --check <crate>`로 다시 계산). 이 도구로 `designcraft-fonts`의 기록도 같은 형식으로 만들었다.

가져올 때 바꾼 것:
- 각 `Cargo.toml`: 작업 공간 상속을 DesignCraft 작업 공간의 버전·기능으로 바꾸고, 서로 간 의존은 `../designcraft-*` 경로로 바꿨다. `[lints]`는 뺐다.
- `designcraft-compose/src/hyphen/mod.rs`: 하이픈 사전 경로를 `assets/hyphenation/`(같이 가져옴)으로 바꿨다. 사전은 Moby Hyphenator II(공개 영역)에서 만들어진 것이고 패턴은 CC0-1.0이다(upstream NOTICE).

가져온 뒤 고친 것(InDesign 2026 실측):
- 첫 줄 기준선 "전각 상자 높이"(`EmboxHeight`, 한국어판 InDesign 기본값). InDesign 2026에서 글꼴 22종을 재서 확인: 로마자 글꼴은 전각의 절반 + 대문자 높이의 절반, 한글 등 CJK 글꼴은 `BASE` 전각 상자, 없으면 상승값.
  - `designcraft-doc/src/item.rs`: `FirstBaseline::EmBox` 추가.
  - `designcraft-idml/src/names.rs`: `EmboxHeight` ↔ `EmBox`(전에는 상승값으로 읽고 `AscentOffset`으로 썼다).
  - `designcraft-compose/src/lib.rs`: `em_box_top`과 `next_baseline`의 `EmBox`. 시험: `em_box_first_baseline_centres_the_em_on_the_cap_height`.
  - `designcraft-fonts/src/fontdb.rs`·`vertical.rs`: `FontFace::base_em_box`(BASE 표만의 전각 상자). OS/2 대문자 높이가 없으면 상승값의 72% 대신 "H" 글자 높이(InDesign과 같음: Trebuchet MS, Arial Black, Arial Narrow, Optima).
- 영어 하이픈: `designcraft-compose/src/hyphen/mod.rs`가 InDesign 2026에서 잰 하이픈 위치로 학습한 미국·영국·캐나다 영어 데이터(`assets/hyphenation/indesign/`, 패턴과 패턴이 틀리는 단어 목록, 만든 법은 같은 폴더 README)를 먼저 쓰고, InDesign 사전의 앞 2자·뒤 2자 제한(`INDESIGN_MIN_BEFORE`/`AFTER`)을 적용한다. 문단·글자 언어로 사전을 고른다(`hyphen::English`, `lib.rs` `hyphenation_languages`; English: UK → 영국, English: Canadian → 캐나다, 그 밖의 영어 → 미국). 잰 단어 미국 217,788·영국 203,339·캐나다 213,849개가 모두 InDesign과 같은 자리에서 나뉜다. 아포스트로피는 합성어처럼 양쪽을 따로 나눈다. 공개 Hunspell 패턴(`assets/hyphenation/hunspell/`)은 지웠고, Moby 단어 목록은 패턴 글자 밖(악센트 등)일 때만 쓴다. 학습기: `examples/indesign_hyph.rs`, `patgen::train_within`(단어 가장자리 자리는 학습에서 뺌). 시험: `breaks_where_indesign_does`(예전 방식으로 잰 미국 46·영국 66개), `languages_pick_indesigns_dictionary`; `dictionary_words`의 "in-ter-na-tion-al"(InDesign 실측, 예전 기대값은 공개 패턴의 뒤 3자 제한을 따른 것). `designcraft-render` `damage.rs` 시험 `only_changed_frames_of_a_thread_are_damaged`는 바꾸는 글자를 숫자로 했다(새 하이픈 지점이 생기면 단락 조판기가 앞 프레임 줄을 다시 나눌 수 있어서).
- 남는 폭 제곱합 조판: `designcraft-compose/src/breaker.rs` `fill_paragraph`와 규칙 `CJK_PARAGRAPH`(CJK 단락 조판기, 한글 없는 줄만 0.15em까지 넘침 허용, 하이픈 없음)·`RAGGED_PARAGRAPH`(Adobe 단락 조판기의 양끝 정렬이 아닌 문단, 하이픈 줄 500). 시험 `indesign_cjk::squared_gaps_choose_the_even_breaks`. upstream 시험 `hyphenation_zone_limits_ragged_hyphens`는 InDesign처럼 단락 조판기에서 하이픈 구역이 효과 없음을 확인하도록 바꿨다(싱글라인은 그대로). `shape.rs`에 시험용 `test_glyph`.
- 글꼴 이름: `designcraft-fonts/src/fontdb.rs` `ScopedFonts::english_family`. IDML이 글꼴을 고유 이름(예: "Apple SD 산돌고딕 Neo")으로 적어도 영어 이름의 글꼴을 찾는다(불러온 글꼴과 시스템 목록의 고유 이름).
- Adobe 단락 조판기(양끝 정렬): `designcraft-compose/src/breaker.rs` `indesign_paragraph`(줄 비용 1.8제곱의 합 + 하이픈 200 + 한 단어 마지막 줄 100, InDesign 실측 맞춤). 줄마다 폭이 다르거나 단락 안 강제 줄바꿈·광학 여백·글자 간격·글자 폭 조절이 있으면 기존 `knuth_plass`. `designcraft-doc` `Composer::ParagraphCjk`(IDML `HL Composer J`)를 추가해 CJK 단락 조판기는 기존 방식으로 둔다(읽기·쓰기에서 이름 보존).
- `designcraft-compose/src/breaker.rs` `greedy`(싱글라인 조판기): 양끝 정렬에서 측정 폭을 넘는 단어를 넣을지 뺄지를 InDesign의 비용(`take_word`)으로 정한다. 전에는 최소 간격으로 줄여서 들어가면 넣고 아니면 뺐다. 하이픈 지점이 있는 단어는 기존 규칙을 쓴다. 시험: `indesign_single_line::matches_measured_boundaries`.
- `designcraft-idml/src/import.rs` 글상자 설정: 문서 기본값(Preferences `TextFramePreference`) → 개체 스타일(기반 스타일 포함) → 글상자 자체 값 순으로 이어받는다. 전에는 글상자에 없는 값을 기본값으로 두어, 개체 스타일의 첫 줄 위치·단 설정 등을 잃었다. 시험: `frame_options_keep_inherited_values_for_absent_attributes`.
- `designcraft-idml/src/import.rs` `para_attrs`: 모든 문단에 한글 음절 사이 줄나눔(`korean_char_breaks`)을 켠다. InDesign은 언어(한국어·영어·없음)와 조판기 4종 모든 조합에서 한글을 음절 사이에서 나눴고, IDML에는 이를 바꾸는 속성이 없다. 이 값은 IDML로 다시 쓰지 않는다. 시험: `tests.rs` `hangul_breaks_between_syllables_as_in_indesign`.

- `designcraft-idml/src/import.rs` 밑줄·취소선 색: IDML의 기본값 "Text Color"(글자색을 따름)를 견본 이름으로 바꾸기 전에 걸러낸다. 전에는 바꾼 뒤에 비교해서 "없음"이 되어 밑줄이 보이지 않았다(magazineA 제목). 시험: `underline_in_text_color_follows_the_text`.
- 빗금 선 기울기: `designcraft-doc` `StrokeType::LeftSlantHash`·`RightSlantHash`, `designcraft-geom/src/stroke_style.rs` `slant_hashed`, `designcraft-idml/src/names.rs`. 전에는 "Left/Right Slant Hash"를 곧은 빗금으로 읽고 썼다. InDesign 2026 PDF(magazineA, 왼쪽→오른쪽 경로)에서 "Left Slant Hash"는 `\`, 간격은 선 굵기의 절반(7pt 선에 3.55pt). 시험: `slanted_hash_leans_its_ticks`.
- `designcraft-fonts/src/fontdb.rs` `design_twins`: 없는 글꼴이 같은 디자인의 무료 글꼴로 있으면 그것으로 그린다(Source Han Sans = Noto Sans CJK, Adobe 명조·고딕 → Noto Serif/Sans KR). 전에는 일반 대체 글꼴로 넘어가 본고딕 문서가 명조로 그려졌다. PPT 쪽은 글꼴 이름이 같은 얼굴만 받으므로 영향 없음. 시험: `adobe_cjk_families_resolve_to_their_noto_twins`.
- 양끝 정렬 간격 나누기(`designcraft-compose` `distribute`), 감싸기 범위(`em_band`, 닿음 포함, 그룹 안 개체), 첫 줄 기준선 상승·대문자·x 높이(`ascent_offset`, `glyph_offset`; `designcraft-fonts` `FontFace::typo_ascent`·`glyph_top`): InDesign 2026 실측. 시험: `indesign_justify`, `ascent_cap_and_x_height_first_baselines_follow_indesign`.
- `designcraft-idml/src/import.rs` `import_idml_mapped`·`SourceIds`: 읽은 쪽 개체·글 흐름(story)의 DesignCraft 번호와 IDML `Self` id 대응표를 함께 돌려준다. `formats/idml`이 원본 XML의 해당 요소를 찾아 고칠 때 쓴다.

## designcraft-images, -render (2026-10-12)

수정: `designcraft-render/src/lib.rs`·`fx.rs` `Renderer::level`(SIMD 수준, 기본은 CPU 감지)과 `simd_baseline()`. 서버에서 x86을 ARM 위에서 흉내 내 돌린 환경(이 Mac의 Colima, Rosetta가 AVX2를 알림)에서 자동 감지된 AVX2 경로가 가로 줄무늬로 깨진 그림을 냈고, 기본 수준(스칼라)으로는 바르게 그렸다(2026-10-12). 문서 작업 서버는 `PRESENT_SIMD=scalar`로 스칼라를 쓴다(PPT 쪽 `present-render`도 같은 설정).


화면 그리기용. 쪽을 비트맵으로 그리는 부품(`crates/render`)과 그것이 쓰는 그림 해독 부품(`crates/images`)이다. 같은 도구로 가져왔고 기록은 각 `PROVENANCE.json`에 있다. 가져올 때 바꾼 것은 `Cargo.toml`(작업 공간 상속을 명시적인 값으로, 서로 간 의존을 경로로, 운영체제별 의존은 `[target]` 표 그대로)뿐이다. 외부 의존성 버전은 DesignCraft `Cargo.lock`과 같게 고정했다.

DesignCraft 문서 모델은 IDML을 다시 저장할 때 지원하지 않는 요소를 지운다(2026-10-10 실측). 원본 보존은 이 부품이 아니라 `formats/idml`이 맡는다.
