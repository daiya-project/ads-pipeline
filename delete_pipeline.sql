-- 특정 unique_id (P-1767769470375)와 관련된 파이프라인과 액션 로그 삭제 쿼리

-- 방법 1: CASCADE가 설정되어 있는 경우 (권장)
-- 파이프라인을 삭제하면 외래 키 제약조건에 의해 자동으로 액션 로그도 삭제됩니다.
DELETE FROM crm_client_pipeline
WHERE unique_id = 'P-1767769470375';

-- 방법 2: CASCADE가 설정되어 있지 않은 경우
-- 먼저 액션 로그를 삭제한 후 파이프라인을 삭제합니다.
-- (방법 1이 실패하는 경우에만 사용)

-- 1단계: 해당 파이프라인의 모든 액션 로그 삭제
DELETE FROM crm_client_actions
WHERE pipeline_id = 'P-1767769470375';

-- 2단계: 파이프라인 삭제
DELETE FROM crm_client_pipeline
WHERE unique_id = 'P-1767769470375';

-- 삭제 전 확인 쿼리 (실행 전에 먼저 확인하세요)
-- SELECT * FROM crm_client_pipeline WHERE unique_id = 'P-1767769470375';
-- SELECT * FROM crm_client_actions WHERE pipeline_id = 'P-1767769470375';
