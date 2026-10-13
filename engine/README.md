# 공통 엔진

Rust core를 native headless(문서 작업 서버의 `present-pptx`·`present-idml`)와 browser WASM(문서 보기 `apps/office`)에 같은 소스로 빌드한다.

- `vendor/`: DesignCraft 고정 커밋에서 가져온 하위 부품(`fonts`, `geom`, `color`, `images`). 출처와 우리 수정 내역은 [vendor/README.md](vendor/README.md)에 기록한다. upstream을 계속 따라가지 않는다.
- 공통 transaction·Undo·journal, 안정 ID·버전, 그리기 목록은 우리 코드로 작성한다. DesignCraft의 명령·Undo 방식을 참고하되 문서 모델에 묶이지 않게 한다.

PPTX의 파일 의미와 PowerPoint 배치 규칙은 `formats/pptx/`가, 출판의 페이지 흐름은 `formats/publishing/`이 소유한다.
