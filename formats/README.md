# 형식별 문서 의미

[PPTX](pptx/README.md)와 [publishing](publishing/README.md)은 공통 문자·기하·렌더링·트랜잭션을 사용하면서 각 형식의 정본과 배치 규칙을 보유한다. 파생 scene는 공통이고, 손실 없는 범용 도형 JSON을 유일 정본으로 가정하지 않는다.

구현 순서·새 모델이 확정되지 않은 DOCX source package는 지금 만들지 않는다. [IDML](idml)은 DesignCraft 부품(`engine/vendor`)으로 읽고 원본 XML을 고쳐 저장한다.
