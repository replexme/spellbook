# PPTX adapter

PowerPoint 파일의 정본·저장·배치 규칙을 구현한다. 원본 패키지를 바이트로 보관하고, 수정할 부분만 XML로 읽어 바뀐 요소만 다시 쓰며, 테마→마스터→레이아웃→슬라이드 상속을 풀어 화면용 결과를 만든다.

AI가 쓰는 편집 명령은 공유 계약(`contracts/native-edit-capabilities.json`)의 이름과 인자를 따르고, 문서 보기(`apps/office/src/commands.mjs`)가 이 엔진의 명령으로 옮긴다. 배치 규칙은 PowerPoint for Mac에서 잰 결과로 맞추며, 각 규칙의 근거는 해당 소스 주석에 적는다.
