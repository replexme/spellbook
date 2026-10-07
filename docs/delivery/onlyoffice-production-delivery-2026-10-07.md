# ONLYOFFICE 운영 전달 — 2026-10-07

## 실행 범위와 승인

사용자의 이전 전체 수행 지시와 10월 7일 운영 반영 재지시에 따라, 검증된 ONLYOFFICE 파일을 실제 운영 경로에 전달한다. `publicReleaseAdmitted`는 이 파일의 공개 전달을 허용하는 선택값이며 모든 운영 사용자 흐름이나 독립 전체 엔진 재컴파일의 완료 표시가 아니다. 과거 로컬 보고서의 출시 보류 문단은 당시 상태로 보존한다.

## 전달할 파일과 제공 자료 확인

선택 배포 manifest `35e9594f3a24b38f99e3acc9dcdadfc0ed41f577e8f452e303068d4da525a633`의 모든 파일, 압축 쌍, 소스 묶음 및 4개 보조 모듈의 대응 소스·재현 결과는 이전 최종 검사와 같다. 수정 SDK JavaScript와 UI는 각각 제공한 CryptPad 수정 소스에서 재현됐으며, 보조 JS/WASM 8개는 제공한 선호 소스와 고정 컴파일러로 재현됐다. x2t는 고정 수정 소스와 서명된 업스트림 빌드 증명·배포 바이트 일치가 근거다. 독립 전체 x2t 및 전체 편집 엔진 재컴파일을 수행했다고 주장하지 않는다.

`/licenses`에서 수정 호스트 소스·파일 해시·빌드 방법과 업스트림 및 수정 엔진 소스 묶음을 제공한다. 엔진의 AGPL-3.0 고지, 원저작권, 수정 표시, 별도 폰트/OFL 및 GUI 고지를 유지한다. 기존 ONLYOFFICE 로고와 엔진 내 법적 고지를 유지한다. 제공 자료와 로고 유지 항목은 [공식 라이선스 FAQ](https://www.onlyoffice.com/license-faq) 및 제공한 라이선스 원문을 기준으로 확인했다. 이 기록은 별도 법률 자문이나 전체 재컴파일 인증을 의미하지 않는다.

## 최초 운영 배포와 검증 기록

작업 주소는 `https://office.spellbook.replex.me`, SDK는 `https://present-office-static-mviaa4yhiq-du.a.run.app`, 독립 미리보기는 `https://present-office-static-141191783520.asia-northeast3.run.app`이다. 모두 기존의 하나의 무자격증명 정적 서버를 사용하며 브라우저 출처는 서로 다르다. 호스트는 `https://spellbook.replex.me`이다. 최소 인스턴스 0, 요청 기반 CPU를 유지한다.

운영 반영 완료: 정적 편집기 revision `present-office-static-static-b287f83f-4160e376-76350d4f`, 웹 `present-web-00294-cod`, AI worker `present-ai-worker-00080-7ds`에 각각 트래픽 100%가 연결됐다. 웹의 실제 설정은 `browser` 편집 모드와 위 작업 주소, 공개 코어 `d70109a5f5244cda85666cfc463e22546f0fccc1`이다. `/api/health` 및 데이터베이스·저장소·계정 읽기 `/api/ready`가 통과했다.

운영의 JS/WASM 보조 파일 8개와 SDK 번들 6개를 내려받아 선택 배포의 SHA-256과 모두 일치함을 확인했다. 기존 세 출처 모두 ONLYOFFICE 준비 응답과 동일한 배포 해시를 반환했다. 소스·법적 고지 12개 경로에 HEAD 요청이 성공했다.

실제 50장 PPTX를 운영 주소에서 열어 슬라이드 추가와 복제 두 항목을 확인했다. 각각 실제 저장 파일이 독립 OpenXML 검증을 통과했고, 실행 취소는 원본 파일 바이트와 정확히 일치했으며 다시 실행은 저장 파일과 정확히 일치했다. 저장 파일을 다시 열었을 때 모든 슬라이드 관찰값이 편집 직후와 같았다. 화면 캡처의 한국어 메뉴·슬라이드·편집 영역·법적 고지를 직접 확인했다. 두 운영 항목 완료 후, 동일 바이트의 나머지 로컬 검증 행렬을 운영에서 반복하는 실행은 중단했다. 운영 10개 항목 전체 통과로 주장하지 않는다. 실제 OS 파일 선택 창은 시험에서 OPFS 파일 핸들로 대체했다. 사용자 계정의 SSO·고객 문서 저장 경로 전체를 이 검사로 증명하지 않는다.

실행 증거는 `artifacts/release-execution-20261007/`의 `production-services-readback.json`, `production-engine-readback.json`, `production-source-readback.json`, `production-real50-structure/report.json` 및 화면/저장 PPTX에 있다. 소유한 작업용 worktree와 브라우저를 정리했다. 작업 이미지도 제거됐다. 공유 로컬 VM에 다른 작업의 실행 중 컨테이너가 있어 VM과 해당 컨테이너는 보존했다.

가비아/DNS는 사용자의 10월 7일 지적으로 중단했다. 별도 서명·Windows 출시 점검까지 사용자 지적으로 제외됐다고 표현한 것은 당시 에이전트의 잘못된 범위 해석이었다. DNS 변경 및 회원가입은 수행하지 않았다. 편집기 교체에 필요하지 않은 도메인 문제로 작업을 넓힌 판단은 잘못이었다.


## 사용자 재지시 이후 남은 검증 — 2026-10-07

임의로 중단했던 나머지 운영 편집 8개를 모두 실행했다. 삭제·이동·크기·레이아웃·이름·숨김·전환·메타데이터가 모두 통과했으며, 최초 추가·복제를 합쳐 10개 전부에서 실제 50장 문서의 편집, 독립 OpenXML 저장 검증, 원본 바이트 정확한 Undo와 저장 바이트 정확한 Redo, 저장 후 전체 슬라이드 동일 재열기를 확인했다. 이전 중단 기록은 당시 경과이며 현재의 미완료 8개를 뜻하지 않는다.

운영 `https://office.spellbook.replex.me/local`에서 실제 Codex 및 Claude Code 구독과 패키지의 로컬 연결 프로그램을 사용해 제목을 수정하고 화면을 검토한 후 파일 저장·재열기를 통과했다. 두 저장 PPTX 모두 첫 슬라이드 XML만 바뀌었고, 다른 49개 슬라이드 XML과 나머지 구성 파일은 바이트 단위로 보존됐다. 첫 슬라이드도 제목 텍스트 하나만 바뀌었고 모든 도형의 위치·크기는 보존됐다. 두 파일의 독립 OpenXML 검증과 수정된 화면 확인을 완료했다. 소유자의 Codex 설정 파일 해시는 실행 전후 같았다.

같은 운영 local 경로에서 직접 편집·파일 저장·PDF 내보내기, 권한 밖 편집 거절, 네트워크 차단 후 편집 및 페이지 재열기 복구, 외부 파일 변경 시 덮어쓰기 거절, 모바일 화면·가로 넘침·보기 전용 처리를 확인했다. 이 결과는 운영 편집기의 로컬 파일 경로에 대한 증거이며 고객 서버 저장 완료를 대신하지 않는다.

**전체 요청 중 실제 계정의 로그인→고객 서버 문서→AI 편집→서버 저장·재열기·복구는 아직 미완료다.** 실행 환경에 정상 로그인으로 발급된 Accounts 세션 파일이 없고, 정식 runner는 `PRESENT_SMOKE_ACCOUNTS_COOKIE_FILE` 부재로 네트워크 실행 전에 실패했다. 사용자에게 비공개 파일 경로만 요청했다. 실제 OAuth 로그인 시작의 등록 client·callback·PKCE·state·nonce 및 로그인 거래 쿠키 발급은 운영 응답에서 확인했다. 인증된 사용자 세션이나 신분을 만들어 이 단계를 통과시키지 않았다. 세션 확보 후 기존 정식 runner로 이어서 확인해야 한다.

최종 증거: `artifacts/release-execution-20261007/production-final-acceptance.json`, `production-real50-remaining8/report.json`, `production-codex50/`, `production-claude50/`, `production-recovery/local-report.json`, `production-auth-start-readback.json`, `authenticated-flow-precondition.log`. 추가 운영 배포나 유료 클라우드 빌드·테스트 실행기는 사용하지 않았다. 소유한 테스트 브라우저, 연결 프로그램과 자식 AI 프로세스를 종료했다. 관련 없는 브라우저 탭과 프로세스는 바꾸지 않았다.
