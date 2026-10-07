# ONLYOFFICE 운영 전달 — 2026-10-07

## 실행 범위와 승인

사용자의 이전 전체 수행 지시와 10월 7일 운영 반영 재지시에 따라, 검증된 ONLYOFFICE 파일을 실제 운영 경로에 전달한다. `publicReleaseAdmitted`는 이 파일의 공개 전달을 허용하는 선택값이며 모든 운영 사용자 흐름이나 독립 전체 엔진 재컴파일의 완료 표시가 아니다. 과거 로컬 보고서의 출시 보류 문단은 당시 상태로 보존한다.

## 전달할 파일과 제공 자료 확인

선택 배포 manifest `35e9594f3a24b38f99e3acc9dcdadfc0ed41f577e8f452e303068d4da525a633`의 모든 파일, 압축 쌍, 소스 묶음 및 4개 보조 모듈의 대응 소스·재현 결과는 이전 최종 검사와 같다. 수정 SDK JavaScript와 UI는 각각 제공한 CryptPad 수정 소스에서 재현됐으며, 보조 JS/WASM 8개는 제공한 선호 소스와 고정 컴파일러로 재현됐다. x2t는 고정 수정 소스와 서명된 업스트림 빌드 증명·배포 바이트 일치가 근거다. 독립 전체 x2t 및 전체 편집 엔진 재컴파일을 수행했다고 주장하지 않는다.

`/licenses`에서 수정 호스트 소스·파일 해시·빌드 방법과 업스트림 및 수정 엔진 소스 묶음을 제공한다. 엔진의 AGPL-3.0 고지, 원저작권, 수정 표시, 별도 폰트/OFL 및 GUI 고지를 유지한다. 기존 ONLYOFFICE 로고와 엔진 내 법적 고지를 유지한다. 제공 자료와 로고 유지 항목은 [공식 라이선스 FAQ](https://www.onlyoffice.com/license-faq) 및 제공한 라이선스 원문을 기준으로 확인했다. 이 기록은 별도 법률 자문이나 전체 재컴파일 인증을 의미하지 않는다.

## 운영 주소와 검증 기록

작업 주소는 `https://office.spellbook.replex.me`, SDK는 `https://present-office-static-mviaa4yhiq-du.a.run.app`, 독립 미리보기는 `https://present-office-static-141191783520.asia-northeast3.run.app`이다. 모두 기존의 하나의 무자격증명 정적 서버를 사용하며 브라우저 출처는 서로 다르다. 호스트는 `https://spellbook.replex.me`이다. 최소 인스턴스 0, 요청 기반 CPU를 유지한다.

운영 반영 완료: 정적 편집기 revision `present-office-static-static-b287f83f-4160e376-76350d4f`, 웹 `present-web-00294-cod`, AI worker `present-ai-worker-00080-7ds`에 각각 트래픽 100%가 연결됐다. 웹의 실제 설정은 `browser` 편집 모드와 위 작업 주소, 공개 코어 `d70109a5f5244cda85666cfc463e22546f0fccc1`이다. `/api/health` 및 데이터베이스·저장소·계정 읽기 `/api/ready`가 통과했다.

운영의 JS/WASM 보조 파일 8개와 SDK 번들 6개를 내려받아 선택 배포의 SHA-256과 모두 일치함을 확인했다. 기존 세 출처 모두 ONLYOFFICE 준비 응답과 동일한 배포 해시를 반환했다. 소스·법적 고지 12개 경로에 HEAD 요청이 성공했다.

실제 50장 PPTX를 운영 주소에서 열어 슬라이드 추가와 복제 두 항목을 확인했다. 각각 실제 저장 파일이 독립 OpenXML 검증을 통과했고, 실행 취소는 원본 파일 바이트와 정확히 일치했으며 다시 실행은 저장 파일과 정확히 일치했다. 저장 파일을 다시 열었을 때 모든 슬라이드 관찰값이 편집 직후와 같았다. 화면 캡처의 한국어 메뉴·슬라이드·편집 영역·법적 고지를 직접 확인했다. 두 운영 항목 완료 후, 동일 바이트의 나머지 로컬 검증 행렬을 운영에서 반복하는 실행은 중단했다. 운영 10개 항목 전체 통과로 주장하지 않는다. 실제 OS 파일 선택 창은 시험에서 OPFS 파일 핸들로 대체했다. 사용자 계정의 SSO·고객 문서 저장 경로 전체를 이 검사로 증명하지 않는다.

실행 증거는 `artifacts/release-execution-20261007/`의 `production-services-readback.json`, `production-engine-readback.json`, `production-source-readback.json`, `production-real50-structure/report.json` 및 화면/저장 PPTX에 있다. 소유한 작업용 worktree와 브라우저를 정리했다. 작업 이미지도 제거됐다. 공유 로컬 VM에 다른 작업의 실행 중 컨테이너가 있어 VM과 해당 컨테이너는 보존했다.

사용자의 10월 7일 지적으로 가비아/DNS 작업과 별도 서명·Windows 출시 점검은 범위에서 제외했다. DNS 변경 및 회원가입은 수행하지 않았다. 편집기 교체에 필요하지 않은 도메인 문제로 작업을 넓힌 판단은 잘못이었다.
