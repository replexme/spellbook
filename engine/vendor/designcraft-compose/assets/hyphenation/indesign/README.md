# InDesign 영어 하이픈 데이터

InDesign 2026이 영어 단어를 실제로 어디서 나누는지 재서 만든 데이터다. Adobe의 하이픈 파일(설치본의 `hyph_en_*.dic`, 머리말 "ADOBE CONFIDENTIAL")은 이 데이터를 만드는 데 쓰지 않았다(복사·변환 없음). InDesign이 조판한 결과만 썼다.

| 파일 | 내용 |
|---|---|
| `en-us.pat.z`, `en-gb.pat.z`, `en-ca.pat.z` | 미국·영국·캐나다 영어 Liang 패턴(TeX 표기 글을 raw deflate로 압축). 잰 하이픈 위치로 DesignCraft 패턴 학습기(`src/hyphen/patgen.rs`)가 학습했다. |
| `measured-en-us.txt`, `measured-en-gb.txt` | 한 단어씩 잰 InDesign의 하이픈 위치(`단어|위치,…`). 시험(`hyphen::tests::breaks_where_indesign_does`)이 이 값과 같은지 본다. |
| `en-us.exc`, `en-gb.exc`, `en-ca.exc` | 패턴이 InDesign과 다르게 나누는 잰 단어와 그 위치(`src/hyphen/dict.rs` 형식). 패턴보다 먼저 본다. |

만드는 법(측정 스크립트는 개발 저장소의 `experiments/indesign-compose`에 있고, InDesign이 있어야 돌므로 공개 코어에는 넣지 않는다):

1. 단어 목록: `experiments/indesign-compose/hyphenation/make-words.py`. 공개 Moby Hyphenator II 목록(Project Gutenberg #3204, 퍼블릭 도메인)과 InDesign 설치본의 영어 철자 사전 단어(접사 규칙으로 펼침), 소문자 a–z 4~40자. 목록은 저장소에 넣지 않는다. 더해서 `extra-words.txt`(라틴어 견본 문장 등 2,742개)와 예전 방식으로 잰 `measured-en-us.txt`·`measured-en-gb.txt`의 5자 이상 단어.
2. 재기: `experiments/indesign-compose/hyphenation/points-fast.jsx`를 `measure-all.sh`(InDesign을 파일 2개마다 다시 띄움)로 숨김 실행한다. 단어마다 표 칸 하나, Courier New(모든 글자 폭이 같음, 합자 끔), 하이픈 제한 1/1, 칸 폭을 한 글자씩 늘리며 첫 줄이 끝나는 자리를 모은다. 같은 방식이 예전 한 단어씩 재기(`points.jsx`)의 112개와 모두 같았다.
3. 학습: `cargo run --release -p designcraft-compose --example indesign_hyph -- <en-us|en-gb|en-ca> assets/hyphenation/indesign <잰 파일>…`. 확인: 같은 명령에 `--check`(이 빌드에 들어간 데이터로 잰 단어를 모두 다시 나눠 InDesign과 다른 단어 수를 센다).

2026-10-12 결과: 잰 단어 미국 217,788 · 영국 203,339 · 캐나다 213,849개, 예외 197 · 324 · 548개, 모두 InDesign과 같다(`--check`). 학습 전에 잰, 목록에 없던 실제 단어 118개에서는 미국 34 · 영국 36 · 캐나다 34개가 다르게 나뉘었다(공개 패턴 59 · 68 · 62개). 자세한 비교는 `experiments/indesign-compose/README.md`.

InDesign의 영어 사전은 단어 앞 2자, 뒤 2자 안에서는 나누지 않는다(`INDESIGN_MIN_BEFORE`/`AFTER`). 문단의 하이픈 설정은 그 위에 따로 적용된다.
