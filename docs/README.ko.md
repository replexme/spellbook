# Spellbook

[English](../README.md) | [한국어](README.ko.md)

Spellbook은 기존 문서를 실제 브라우저 편집기로 열어 사람과 AI가 같은 편집 가능한 파일을
함께 고치고, 변경 결과의 문서 구조와 렌더링 화면을 검증한 뒤 반영하는 오픈소스 문서
작업공간이다.

현재 실제로 사용할 수 있는 형식은 **PowerPoint (`.pptx`)**다. DOCX와 Spellbook의 네이티브
페이지 레이아웃 문서는 계획된 어댑터이며 아직 동작하는 기능으로 안내하지 않는다.

## 공개 저장소의 범위

이 저장소에는 셀프호스팅에 필요한 전체 제품이 들어 있다.

- 웹 작업공간과 WOPI host
- AI 연결 계층과 PPTX 구조 보존 편집
- LibreOffice 렌더러 조정
- 공개 평가·회귀 검증 도구

Replex 계정이나 Google Cloud 없이 실행할 수 있다. Replex의 관리형 서비스는 비공개 배포,
결제·이용 권한, 관리형 계정과 자격증명, 비공개 평가 자료를 별도 저장소에서 관리한다. 관리형
서비스는 공개 코어에 의존하지만 공개 코어는 관리형 모듈을 가져오지 않는다.

## 로컬 실행

Docker Compose, Node.js 22와 pnpm 10.26이 필요하다.

```bash
pnpm selfhost:setup
pnpm selfhost:up
```

설정 명령이 출력한 이메일과 비밀번호로 <http://localhost:3000>에 로그인한다. 작업공간에서
지원되는 로컬 AI 구독을 연결하면 AI 편집을 사용할 수 있고, AI를 연결하지 않아도 직접 편집할
수 있다.

첫 빌드는 고정된 LibreOffice·Collabora 이미지를 내려받으므로 시간이 걸릴 수 있다. 이후에는
이미지와 영속 volume을 재사용한다. 이 명령은 서비스가 정상 상태가 된 뒤 사용 중인 이미지와
구성요소별 롤백 이미지 하나만 남기고 이전 Spellbook 이미지를 정리한다. 다른 프로젝트 이미지와
문서·데이터베이스 volume은 건드리지 않는다. 설정과 서비스 상태는 `pnpm selfhost:doctor`로 확인한다.

## 제품 계약

- 업로드한 파일은 변경하지 않는 원본으로 보존한다.
- 편집은 새 버전을 만들며 승인된 버전도 평면 이미지가 아니라 편집 가능한 파일로 남는다.
- AI에는 현재 렌더링 화면과 형식별 구조·권한을 함께 전달한다.
- 변경 후보는 사용자에게 제시하기 전에 다시 렌더링하고 구조를 검증한다.
- 지원하지 않는 구성요소는 보존하거나 작업을 차단하며 조용히 다른 형태로 바꾸지 않는다.

[아키텍처](architecture/document-platform.md), [형식 지원 상태](product/format-support.md),
[다중 형식 로드맵](product/multiformat-roadmap.md),
[오픈 코어 경계](architecture/open-core-boundary.md)에서 상세 계약을 확인할 수 있다.

## 개발과 기여

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm test:e2e
```

공개 경계 검사는 관리형 인프라, 비공개 계정·자격증명·corpus 경로가 이 저장소에 들어오면
실패한다. 렌더링 변경에는 재배포 가능한 공개 fixture 또는 재현 가능한 원천과 회귀 테스트를
함께 추가한다. 자세한 규칙은 [CONTRIBUTING.md](../CONTRIBUTING.md)와
[SECURITY.md](../SECURITY.md)를 따른다.

고정된 공개 회귀 corpus가 필요하면 다음 명령으로 hash를 검증해 ignored 경로에 받는다.

```bash
pnpm corpus:fetch-public -- \
  --renderer-image <libreoffice-image> \
  --renderer-version <libreoffice-release>
```

## 라이선스

Spellbook이 작성한 소스는 MPL-2.0으로 배포한다. 제3자 구성요소와 수정 파일은 각자의
라이선스를 유지한다. [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)와 `../LICENSES/`를
확인한다.
