// 전역 변수
let allPipelines = [];
let filteredPipelines = [];
let sortState = { field: null, direction: null };
let currentSection = 'active';
let fullHistoryCache = []; // Board 섹션용 액션 히스토리 캐시

// Supabase에서 데이터 로드
async function loadPipelineData() {
    try {
        // crm_pipeline_current_state View에서 데이터 가져오기
        const client = window.supabaseClient;
        if (!client) {
            throw new Error('Supabase 클라이언트가 초기화되지 않았습니다.');
        }
        
        // 파이프라인 데이터와 액션 데이터를 동시에 로드
        const [pipelineRes, actionsRes, followupRes] = await Promise.all([
            client
                .from('crm_pipeline_current_state')
                .select('*')
                .order('created_at', { ascending: false }),
            client
                .from('crm_client_actions')
                .select('*')
                .order('action_date', { ascending: false }),
            client
                .from('crm_client_pipeline')
                .select('unique_id, pipeline_followup')
        ]);

        if (pipelineRes.error) {
            console.error('Supabase 오류:', pipelineRes.error);
            throw pipelineRes.error;
        }
        if (actionsRes.error) {
            console.error('Supabase 오류:', actionsRes.error);
            throw actionsRes.error;
        }
        if (followupRes.error) {
            console.error('Supabase 오류:', followupRes.error);
            throw followupRes.error;
        }

        // pipeline_followup 값을 매핑
        const followupMap = {};
        if (followupRes.data) {
            followupRes.data.forEach(p => {
                followupMap[p.unique_id] = p.pipeline_followup;
            });
        }

        // pipeline_followup 값을 병합
        allPipelines = (pipelineRes.data || []).map(p => ({
            ...p,
            pipeline_followup: followupMap[p.unique_id] || false
        }));
        
        // Board 섹션용 히스토리 캐시 생성 (reference 스크립트 형식에 맞게 변환)
        fullHistoryCache = (actionsRes.data || []).map(action => {
            // action_type 매핑: email -> Email, call -> Cold Call, meeting -> Meeting
            let actionType = action.action_type || '';
            if (actionType === 'email') actionType = 'Email';
            else if (actionType === 'call') actionType = 'Cold Call';
            else if (actionType === 'meeting') actionType = 'Meeting';
            
            // stage 매핑: contact -> Contact, lead -> Lead, propose -> Negotiation, closed_won -> Closed Won, closed_lost -> Closed Lost
            let stage = action.stage || '';
            if (stage === 'contact') stage = 'Contact';
            else if (stage === 'lead') stage = 'Lead';
            else if (stage === 'propose') stage = 'Negotiation';
            else if (stage === 'closed_won') stage = 'Closed Won';
            else if (stage === 'closed_lost') stage = 'Closed Lost';
            
            return {
                uniqueId: action.pipeline_id,
                date: action.action_date || (action.created_at ? action.created_at.split('T')[0] : ''),
                action: actionType,
                stage: stage,
                budget: action.budget || 0,
                memo: action.memo || ''
            };
        });
        
        // 필터 옵션 업데이트
        updateFilterOptions();
        
        // 최초 접속 시 모든 정렬 아이콘 숨기기
        document.querySelectorAll('.sort-icon').forEach(icon => {
            icon.style.display = 'none';
        });
        
        // 섹션별 필터 적용
        applyGlobalFilters();
        
        // Board 섹션이 활성화되어 있으면 대시보드 업데이트
        if (currentSection === 'board') {
            updateDashboard();
        }
        
        // 정렬 적용 (기존 정렬 상태 유지)
        if (sortState.field) {
            applySorting();
        }
    } catch (error) {
        console.error('데이터 로드 오류:', error);
        const tbody = document.getElementById('pipelineList');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="14" class="text-center py-20 text-red-400">데이터를 불러오는 중 오류가 발생했습니다.</td></tr>';
        }
    }
}

// 필터 옵션 업데이트
function updateFilterOptions() {
    // Owner 필터 업데이트
    const ownerSelect = document.getElementById('global-filter-owner');
    if (ownerSelect) {
        const owners = [...new Set(allPipelines.map(p => p.manager_name).filter(Boolean))].sort();
        ownerSelect.innerHTML = '<option value="">Owner</option>';
        owners.forEach(owner => {
            const option = document.createElement('option');
            option.value = owner;
            option.textContent = owner;
            ownerSelect.appendChild(option);
        });
    }
    
    // 신규 등록 모달의 Owner 셀렉트 박스 업데이트
    loadOwnerOptions();
}

// Owner 옵션 로드 (신규 등록 모달용)
async function loadOwnerOptions() {
    try {
        const client = window.supabaseClient;
        if (!client) return;

        const { data, error } = await client
            .from('managers')
            .select('id, manager_name')
            .eq('manager_team', 'ads')
            .not('id', 'eq', 98)
            .not('id', 'eq', 99)
            .order('manager_name');

        if (error) throw error;

        const ownerSelect = document.getElementById('newPipelineOwner');
        if (ownerSelect) {
            ownerSelect.innerHTML = '';
            data.forEach(manager => {
                const option = document.createElement('option');
                option.value = manager.manager_name;
                option.textContent = manager.manager_name;
                if (manager.manager_name === 'Jongmin Lee') {
                    option.selected = true;
                }
                ownerSelect.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Owner 옵션 로드 오류:', error);
    }
}

// 표 렌더링
function renderTable() {
    const tbody = document.getElementById('pipelineList');
    if (!tbody) return;

    tbody.innerHTML = '';

    if (filteredPipelines.length === 0) {
        tbody.innerHTML = '<tr><td colspan="14" class="text-center py-20 text-gray-400">데이터가 없습니다.</td></tr>';
        return;
    }

    filteredPipelines.forEach(item => {
        const row = document.createElement('tr');
        row.className = 'hover-row';

        // DATE: 가장 최근 action_date (last_date) - font-mono 적용
        const dateCell = document.createElement('td');
        dateCell.className = 'col-date';
        const lastDate = item.last_date || item.created_at?.split('T')[0] || '-';
        dateCell.innerHTML = `<span class="text-xs font-mono">${lastDate}</span>`;
        row.appendChild(dateCell);

        // PRODUCT - btn-count 스타일 적용, 폰트 크기 0.65rem
        const productCell = document.createElement('td');
        productCell.className = 'col-prod';
        const product = item.product || '-';
        if (product !== '-') {
            productCell.innerHTML = `<span class="font-bold" style="font-size: 0.65rem; color: #2563eb; background-color: #eff6ff; padding: 2px 8px; border-radius: 9999px; border: 1px solid #dbeafe; display: inline-block;">${product}</span>`;
        } else {
            productCell.innerHTML = '<span class="text-xs">-</span>';
        }
        row.appendChild(productCell);

        // CLIENT - 볼드 처리 및 편집 버튼 추가 (텍스트 오버플로우 처리, 텍스트는 중앙 정렬, 버튼은 우측)
        const clientCell = document.createElement('td');
        clientCell.className = 'col-client group';
        clientCell.style.position = 'relative';
        clientCell.style.cursor = 'pointer';
        const clientName = item.client_name || '-';
        const clientContent = clientName !== '-' 
            ? `<div class="flex items-center justify-between gap-1" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"><span class="text-xs font-bold" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; text-align: center;">${clientName}</span><span class="btn-edit material-symbols-outlined text-[16px] opacity-20 group-hover:opacity-100 flex-shrink-0" onclick="event.stopPropagation(); editClient('${item.unique_id || ''}', '${clientName.replace(/'/g, "\\'")}')" style="pointer-events: auto;">edit</span></div>`
            : '<span class="text-xs">-</span>';
        clientCell.innerHTML = clientContent;
        row.appendChild(clientCell);

        // CAMPAIGN
        const campaignCell = document.createElement('td');
        campaignCell.className = 'col-camp';
        campaignCell.innerHTML = `<span class="text-xs">${item.campaign || '-'}</span>`;
        row.appendChild(campaignCell);

        // CNT: action_count - btn-count 스타일 적용, 클릭 시 아코디언 확장
        const cntCell = document.createElement('td');
        cntCell.className = 'col-count';
        const actionCount = item.action_count || 0;
        const uniqueId = item.unique_id || '';
        if (actionCount > 0) {
            cntCell.innerHTML = `<span class="btn-count cursor-pointer" onclick="toggleActionHistory('${uniqueId}', this)" data-pipeline-id="${uniqueId}">${actionCount}</span>`;
        } else {
            cntCell.innerHTML = '<span class="text-xs">0</span>';
        }
        row.appendChild(cntCell);

        // F/up: pipeline_followup
        const followupCell = document.createElement('td');
        followupCell.className = 'col-followup';
        // pipeline_followup 값 체크 (다양한 boolean 표현 지원)
        const followupValue = item.pipeline_followup;
        const followup = followupValue === true || followupValue === 't' || followupValue === 1 || followupValue === 'true';
        if (followup) {
            followupCell.innerHTML = '<span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-red-100 text-red-600"><span class="material-symbols-outlined" style="font-size:16px;">notifications_active</span></span>';
        } else {
            followupCell.innerHTML = '<span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 text-gray-400"><span class="material-symbols-outlined" style="font-size:16px;">check_circle</span></span>';
        }
        row.appendChild(followupCell);

        // OWNER: manager_name - 아이콘 추가 (크기 120% 확대, 세로축 중앙 정렬)
        const ownerCell = document.createElement('td');
        ownerCell.className = 'col-owner';
        const ownerName = item.manager_name || '-';
        if (ownerName !== '-') {
            ownerCell.innerHTML = `<div class="flex items-center justify-center gap-1"><span class="material-symbols-outlined text-[13.104px] text-gray-400" style="vertical-align: middle;">person</span><span class="text-xs" style="vertical-align: middle;">${ownerName}</span></div>`;
        } else {
            ownerCell.innerHTML = '<span class="text-xs">-</span>';
        }
        row.appendChild(ownerCell);

        // ACTION: last_action_type - 우측에 + 버튼 추가 (크기 0.9배, 텍스트는 중앙 정렬, 버튼은 우측)
        const actionCell = document.createElement('td');
        actionCell.className = 'col-action';
        const actionType = item.last_action_type || '';
        // uniqueId는 위에서 이미 선언됨 (154번째 줄)
        let actionText = '';
        
        // Action Type 표시 (중앙 정렬)
        if (actionType === 'meeting') {
            actionText = '<span class="px-2 py-0.5 rounded bg-amber-50 text-amber-700 text-[11px] font-bold border border-amber-100">Meeting</span>';
        } else if (actionType === 'email') {
            actionText = '<span class="text-indigo-600 font-bold text-xs">Email</span>';
        } else if (actionType === 'call') {
            actionText = '<span class="text-gray-500 font-bold text-xs">Call</span>';
        } else {
            actionText = '<span class="text-gray-400 text-xs">-</span>';
        }
        
        // + 버튼 추가 (우측, 크기 0.9배, 더 연한 폰트 컬러)
        const addButton = `<button onclick="openRecordActionModal('${uniqueId}')" class="material-symbols-outlined hover:text-blue-600 flex-shrink-0" style="font-size: 12.96px; color: #d1d5db;">add</button>`;
        
        actionCell.innerHTML = `<div class="group flex items-center justify-between gap-1"><span style="flex: 1; text-align: center;">${actionText}</span>${addButton}</div>`;
        row.appendChild(actionCell);

        // STAGE: current_stage - 우측에 편집 아이콘 추가
        const stageCell = document.createElement('td');
        stageCell.className = 'col-stage group';
        stageCell.style.cursor = 'pointer';
        const stage = item.current_stage || '';
        let stageClass = '';
        if (stage === 'closed_won') stageClass = 'bg-green-100 text-green-700 px-2 py-0.5 rounded';
        else if (stage === 'propose') stageClass = 'bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded';
        else if (stage === 'closed_lost') stageClass = 'text-red-400';
        else if (stage === 'lead') stageClass = 'text-blue-500';
        else stageClass = 'text-gray-400';
        
        const stageText = formatStage(stage);
        const stageContent = stage 
            ? `<span class="${stageClass} text-xs font-medium">${stageText}</span>`
            : '<span class="text-xs text-gray-400">-</span>';
        const editIcon = `<span class="btn-edit material-symbols-outlined text-[16px] opacity-20 group-hover:opacity-100 flex-shrink-0" onclick="event.stopPropagation(); editLastAction('${uniqueId}')" style="pointer-events: auto;">edit</span>`;
        stageCell.innerHTML = `<div class="flex items-center justify-between gap-1"><span style="flex: 1; text-align: center;">${stageContent}</span>${stage ? editIcon : ''}</div>`;
        row.appendChild(stageCell);

        // BUDGET: current_budget - font-mono 적용
        const budgetCell = document.createElement('td');
        budgetCell.className = 'col-budget';
        const budget = item.current_budget || 0;
        budgetCell.innerHTML = `<span class="text-xs font-mono">${budget > 0 ? budget.toLocaleString() : '-'}</span>`;
        row.appendChild(budgetCell);

        // MEMO: last_memo
        const memoCell = document.createElement('td');
        memoCell.className = 'col-memo';
        const memo = item.last_memo || '';
        if (memo) {
            const shortMemo = memo.length > 30 ? memo.substring(0, 30) + '...' : memo;
            // HTML 특수문자 이스케이프 후 onclick에 전달
            const safeMemo = memo.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
            memoCell.innerHTML = `<span class="cursor-pointer text-xs hover:text-blue-600" onclick="showMemoModal('${safeMemo}')">${shortMemo}</span>`;
        } else {
            memoCell.innerHTML = '<span class="text-gray-400 text-xs">-</span>';
        }
        row.appendChild(memoCell);

        // NAME: contact_name
        const nameCell = document.createElement('td');
        nameCell.className = 'col-contact';
        nameCell.innerHTML = `<span class="text-xs">${item.contact_name || '-'}</span>`;
        row.appendChild(nameCell);

        // PHONE: contact_phone (하이픈 자동 적용)
        const phoneCell = document.createElement('td');
        phoneCell.className = 'col-phone';
        const phone = item.contact_phone || '';
        const formattedPhone = formatPhoneNumber(phone);
        phoneCell.innerHTML = `<span class="text-xs">${formattedPhone}</span>`;
        row.appendChild(phoneCell);

        // E-MAIL: contact_email (클릭 시 클립보드 복사)
        const emailCell = document.createElement('td');
        emailCell.className = 'col-email';
        const email = item.contact_email || '';
        if (email && email !== '-') {
            emailCell.innerHTML = `<span class="text-xs cursor-pointer hover:text-blue-600 hover:underline" onclick="copyEmailToClipboard('${email.replace(/'/g, "\\'")}')">${email}</span>`;
        } else {
            emailCell.innerHTML = '<span class="text-xs">-</span>';
        }
        row.appendChild(emailCell);

        tbody.appendChild(row);
    });
}

// 액션 히스토리 토글 (아코디언)
async function toggleActionHistory(uniqueId, clickedElement) {
    try {
        const row = clickedElement.closest('tr');
        if (!row) return;

        // 현재 행의 다음 형제 요소 확인
        let nextSibling = row.nextElementSibling;
        const isExpanded = nextSibling && nextSibling.classList.contains('history-row');

        if (isExpanded) {
            // 닫기: 현재 행의 히스토리 행만 제거
            while (nextSibling && nextSibling.classList.contains('history-row')) {
                const toRemove = nextSibling;
                nextSibling = nextSibling.nextElementSibling;
                toRemove.remove();
            }
        } else {
            // 다른 모든 열려있는 아코디언 닫기
            const allHistoryRows = document.querySelectorAll('.history-row');
            allHistoryRows.forEach(historyRow => {
                historyRow.remove();
            });
            // 열기: 액션 히스토리 로드 및 표시
            const client = window.supabaseClient;
            if (!client) {
                throw new Error('Supabase 클라이언트가 초기화되지 않았습니다.');
            }

            // 파이프라인 정보 가져오기
            const pipeline = allPipelines.find(p => p.unique_id === uniqueId);
            if (!pipeline) return;

            // 모든 액션 로그 가져오기 (action_date 기준 내림차순)
            const { data: actions, error } = await client
                .from('crm_client_actions')
                .select('*')
                .eq('pipeline_id', uniqueId)
                .order('action_date', { ascending: false });

            if (error) throw error;

            // 가장 최근 액션 제외 (첫 번째 항목 제외)
            const historyActions = actions && actions.length > 1 ? actions.slice(1) : [];

            if (historyActions.length === 0) {
                // 히스토리가 없으면 아무것도 표시하지 않음
                return;
            }

            // 히스토리 행 생성 (원본 테이블과 동일한 td 구조 사용)
            historyActions.forEach((action, index) => {
                const historyRow = document.createElement('tr');
                historyRow.className = 'history-row';
                historyRow.style.backgroundColor = '#fafbfc'; // 아주 연한 회색 배경

                // Date (원본의 0.95배 크기, 0.75rem * 0.95 = 0.7125rem)
                const dateCell = document.createElement('td');
                dateCell.className = 'col-date';
                dateCell.style.backgroundColor = '#fafbfc';
                dateCell.style.padding = '0.75rem 0.5rem';
                dateCell.style.textAlign = 'center';
                dateCell.innerHTML = `<span class="font-mono" style="font-size: 0.7125rem;">${action.action_date || action.created_at?.split('T')[0] || '-'}</span>`;
                historyRow.appendChild(dateCell);

                // Product (빈 셀)
                const prodCell = document.createElement('td');
                prodCell.className = 'col-prod';
                prodCell.style.backgroundColor = '#fafbfc';
                prodCell.style.padding = '0.75rem 0.5rem';
                prodCell.style.textAlign = 'center';
                prodCell.innerHTML = '';
                historyRow.appendChild(prodCell);

                // Client (0.95배 크기, 굵은 폰트 제거, 중앙 정렬)
                const clientCell = document.createElement('td');
                clientCell.className = 'col-client';
                clientCell.style.backgroundColor = '#fafbfc';
                clientCell.style.padding = '0.75rem 0.5rem';
                clientCell.style.textAlign = 'center';
                const clientName = pipeline.client_name || '-';
                clientCell.innerHTML = `<span style="font-size: 0.7125rem; ${clientName === '-' ? 'color: #cbd5e1;' : ''}">${clientName}</span>`;
                historyRow.appendChild(clientCell);

                // Campaign (0.95배 크기)
                const campaignCell = document.createElement('td');
                campaignCell.className = 'col-camp';
                campaignCell.style.backgroundColor = '#fafbfc';
                campaignCell.style.padding = '0.75rem 0.5rem';
                campaignCell.style.textAlign = 'center';
                campaignCell.innerHTML = `<span style="font-size: 0.7125rem;">${pipeline.campaign || '-'}</span>`;
                historyRow.appendChild(campaignCell);

                // CNT (빈 셀)
                const cntCell = document.createElement('td');
                cntCell.className = 'col-count';
                cntCell.style.backgroundColor = '#fafbfc';
                cntCell.style.padding = '0.75rem 0.5rem';
                cntCell.style.textAlign = 'center';
                cntCell.innerHTML = '';
                historyRow.appendChild(cntCell);

                // F/up (action_followup 값 표시, true면 붉은 종 90% 크기, false면 - 표시)
                const followupCell = document.createElement('td');
                followupCell.className = 'col-followup';
                followupCell.style.backgroundColor = '#fafbfc';
                followupCell.style.padding = '0.75rem 0.5rem';
                followupCell.style.textAlign = 'center';
                const actionFollowup = action.action_followup || false;
                if (actionFollowup) {
                    followupCell.innerHTML = '<span class="inline-flex items-center justify-center rounded-full bg-red-100 text-red-600" style="width: 21.6px; height: 21.6px;"><span class="material-symbols-outlined" style="font-size:14.4px;">notifications_active</span></span>';
                } else {
                    followupCell.innerHTML = '<span style="font-size: 0.7125rem; color: #cbd5e1;">-</span>';
                }
                historyRow.appendChild(followupCell);

                // Owner (빈 셀)
                const ownerCell = document.createElement('td');
                ownerCell.className = 'col-owner';
                ownerCell.style.backgroundColor = '#fafbfc';
                ownerCell.style.padding = '0.75rem 0.5rem';
                ownerCell.style.textAlign = 'center';
                ownerCell.innerHTML = '';
                historyRow.appendChild(ownerCell);

                // Action (0.95배 크기, 굵은 폰트 제거, 중앙 정렬)
                const actionCell = document.createElement('td');
                actionCell.className = 'col-action';
                actionCell.style.backgroundColor = '#fafbfc';
                actionCell.style.padding = '0.75rem 0.5rem';
                actionCell.style.textAlign = 'center';
                const actionType = action.action_type || '';
                if (actionType === 'meeting') {
                    actionCell.innerHTML = '<span class="px-2 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-100" style="font-size: 0.7125rem;">Meeting</span>';
                } else if (actionType === 'email') {
                    actionCell.innerHTML = '<span class="text-indigo-600" style="font-size: 0.7125rem;">Email</span>';
                } else if (actionType === 'call') {
                    actionCell.innerHTML = '<span class="text-gray-500" style="font-size: 0.7125rem;">Call</span>';
                } else {
                    actionCell.innerHTML = '<span style="font-size: 0.7125rem; color: #cbd5e1;">-</span>';
                }
                historyRow.appendChild(actionCell);

                // Stage (0.95배 크기, 굵은 폰트 제거, 수정 버튼 추가, 중앙 정렬)
                const stageCell = document.createElement('td');
                stageCell.className = 'col-stage group';
                stageCell.style.backgroundColor = '#fafbfc';
                stageCell.style.padding = '0.75rem 0.5rem';
                stageCell.style.textAlign = 'center';
                stageCell.style.cursor = 'pointer';
                const stage = action.stage || '';
                const actionId = action.id || '';
                if (stage) {
                    let stageClass = '';
                    if (stage === 'closed_won') stageClass = 'bg-green-100 text-green-700 px-2 py-0.5 rounded';
                    else if (stage === 'propose') stageClass = 'bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded';
                    else if (stage === 'closed_lost') stageClass = 'text-red-400';
                    else if (stage === 'lead') stageClass = 'text-blue-500';
                    else stageClass = 'text-gray-400';
                    const stageText = formatStage(stage);
                    stageCell.innerHTML = `<div class="flex items-center justify-center gap-1"><span class="${stageClass}" style="font-size: 0.7125rem;">${stageText}</span><span class="btn-edit material-symbols-outlined text-[16px] opacity-20 group-hover:opacity-100 flex-shrink-0" onclick="event.stopPropagation(); openEditActionModal('${uniqueId}', '${actionId}')" style="cursor: pointer; pointer-events: auto;">edit</span></div>`;
                } else {
                    stageCell.innerHTML = '<span style="font-size: 0.7125rem; color: #cbd5e1;">-</span>';
                }
                historyRow.appendChild(stageCell);

                // Budget (- 표시)
                const budgetCell = document.createElement('td');
                budgetCell.className = 'col-budget';
                budgetCell.style.backgroundColor = '#fafbfc';
                budgetCell.style.padding = '0.75rem 0.5rem';
                budgetCell.style.textAlign = 'center';
                budgetCell.innerHTML = '<span style="font-size: 0.7125rem; color: #cbd5e1;">-</span>';
                historyRow.appendChild(budgetCell);

                // Memo (메모+네임+콜+이메일 영역 확장, colspan=4, 중앙 정렬)
                const memoCell = document.createElement('td');
                memoCell.className = 'col-memo';
                memoCell.colSpan = 4; // 메모 + 네임 + 콜 + 이메일
                memoCell.style.backgroundColor = '#fafbfc';
                memoCell.style.padding = '0.75rem 0.5rem';
                memoCell.style.textAlign = 'center';
                const memo = action.memo || '';
                if (memo) {
                    const safeMemo = memo.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
                    memoCell.innerHTML = `<span class="cursor-pointer hover:text-blue-600" style="font-size: 0.7125rem;" onclick="showMemoModal('${safeMemo}')">${memo}</span>`;
                } else {
                    memoCell.innerHTML = '<span style="font-size: 0.7125rem; color: #cbd5e1;">-</span>';
                }
                historyRow.appendChild(memoCell);

                // 현재 행 다음에 히스토리 행 삽입
                const insertAfter = index === 0 ? row : row.parentNode.querySelector(`tr[data-history-index="${index - 1}"]`);
                if (insertAfter) {
                    historyRow.setAttribute('data-history-index', index.toString());
                    row.parentNode.insertBefore(historyRow, insertAfter.nextSibling);
                }
            });
        }
    } catch (error) {
        console.error('액션 히스토리 로드 오류:', error);
        alert('액션 히스토리를 불러오는 중 오류가 발생했습니다.');
    }
}

// Stage 포맷팅 (소문자 -> 표시용)
function formatStage(stage) {
    const stageMap = {
        'contact': 'Contact',
        'lead': 'Lead',
        'propose': 'Propose',
        'closed_won': 'Closed Won',
        'closed_lost': 'Closed Lost'
    };
    return stageMap[stage] || stage;
}

// Action Type 포맷팅
function formatActionType(actionType) {
    const actionMap = {
        'meeting': 'Meeting',
        'call': 'Call',
        'email': 'Email'
    };
    return actionMap[actionType] || actionType;
}

// 전화번호 포맷팅 (하이픈 자동 적용)
function formatPhoneNumber(phone) {
    if (!phone || phone === '-') return '-';
    
    // 이미 하이픈이 있으면 그대로 반환
    if (phone.includes('-')) {
        return phone;
    }
    
    // 숫자만 추출
    const numbers = phone.replace(/\D/g, '');
    
    // 길이에 따라 하이픈 적용
    if (numbers.length === 10) {
        // 010-1234-5678 형식
        return `${numbers.substring(0, 3)}-${numbers.substring(3, 7)}-${numbers.substring(7)}`;
    } else if (numbers.length === 11) {
        // 010-1234-5678 형식
        return `${numbers.substring(0, 3)}-${numbers.substring(3, 7)}-${numbers.substring(7)}`;
    } else if (numbers.length === 9) {
        // 02-1234-5678 형식
        return `${numbers.substring(0, 2)}-${numbers.substring(2, 6)}-${numbers.substring(6)}`;
    } else if (numbers.length === 8) {
        // 02-123-4567 형식
        return `${numbers.substring(0, 2)}-${numbers.substring(2, 5)}-${numbers.substring(5)}`;
    }
    
    // 형식이 맞지 않으면 원본 반환
    return phone;
}

// E-Mail 클립보드 복사
async function copyEmailToClipboard(email) {
    try {
        await navigator.clipboard.writeText(email);
        showToast('E-Mail 주소를 클립보드로 복사하였습니다');
    } catch (err) {
        // 클립보드 API가 지원되지 않는 경우 대체 방법
        const textArea = document.createElement('textarea');
        textArea.value = email;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        document.body.appendChild(textArea);
        textArea.select();
        try {
            document.execCommand('copy');
            showToast('E-Mail 주소를 클립보드로 복사하였습니다');
        } catch (err) {
            console.error('클립보드 복사 실패:', err);
            alert('E-Mail 주소를 클립보드로 복사하는데 실패했습니다.');
        }
        document.body.removeChild(textArea);
    }
}

// 토스트 메시지 표시
function showToast(message) {
    // 기존 토스트가 있으면 제거
    const existingToast = document.getElementById('toast-message');
    if (existingToast) {
        existingToast.remove();
    }
    
    // 토스트 생성
    const toast = document.createElement('div');
    toast.id = 'toast-message';
    toast.className = 'fixed top-20 left-1/2 transform -translate-x-1/2 bg-gray-800 text-white px-6 py-3 rounded-lg shadow-lg z-50 flex items-center gap-2';
    toast.innerHTML = `
        <span class="material-symbols-outlined text-[18px]">check_circle</span>
        <span class="text-sm font-medium">${message}</span>
    `;
    
    document.body.appendChild(toast);
    
    // 3초 후 자동 제거
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s';
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 300);
    }, 3000);
}

// 필터 적용
function applyGlobalFilters() {
    const search = document.getElementById('global-search')?.value.toLowerCase() || '';
    const product = document.getElementById('global-filter-product')?.value || '';
    const owner = document.getElementById('global-filter-owner')?.value || '';
    const stage = document.getElementById('global-filter-stage')?.value || '';

    filteredPipelines = allPipelines.filter(p => {
        // Active 섹션: Action이 meeting이거나 pipeline_followup이 true인 파이프라인만 표시
        // 이 조건은 항상 먼저 체크 (정렬, 필터 적용/해제와 무관하게)
        if (currentSection === 'active') {
            const isMeeting = (p.last_action_type || '') === 'meeting';
            const isFollowup = p.pipeline_followup === true;
            if (!isMeeting && !isFollowup) {
                return false;
            }
        }
        
        // 모든 필터 적용 (검색, 프로덕트, 오너, 스테이지)
        const matchSearch = !search || 
            (p.client_name && p.client_name.toLowerCase().includes(search)) || 
            (p.campaign && p.campaign.toLowerCase().includes(search));
        const matchProduct = !product || p.product === product;
        const matchOwner = !owner || p.manager_name === owner;
        
        // Stage 필터링: 데이터베이스의 stage 값(소문자)과 필터 값(소문자) 직접 비교
        const matchStage = !stage || (p.current_stage || '') === stage;
        
        // Active 섹션: Active 조건 + 모든 필터 적용
        // Pipe 섹션: 모든 필터 적용
        return matchSearch && matchProduct && matchOwner && matchStage;
    });

    // 필터 적용 후 정렬이 설정되어 있으면 정렬 적용
    if (sortState.field) {
        applySorting('skip-filter');
    } else {
        renderTable();
    }
}

// 정렬
function toggleSort(field) {
    // 모든 헤더에서 sort-active 클래스 제거
    document.querySelectorAll('th').forEach(th => {
        th.classList.remove('sort-active');
    });
    
    // 모든 아이콘 제거
    document.querySelectorAll('.sort-icon').forEach(icon => {
        icon.textContent = '';
        icon.style.display = 'none';
    });

    if (sortState.field === field) {
        // 같은 필드를 클릭한 경우: asc -> desc -> null (정렬 없음)
        if (sortState.direction === 'asc') {
            sortState.direction = 'desc';
        } else if (sortState.direction === 'desc') {
            sortState.field = null;
            sortState.direction = null;
            // 정렬 해제 시 필터를 다시 적용하여 Active 섹션 조건 유지
            applyGlobalFilters();
            return;
        }
    } else {
        // 다른 필드를 클릭한 경우: asc로 시작
        sortState.field = field;
        sortState.direction = 'asc';
    }

    // 정렬된 헤더에만 화살표 표시
    const icon = document.getElementById(`sort-icon-${field}`);
    if (icon) {
        icon.style.display = 'inline';
        icon.textContent = sortState.direction === 'asc' ? 'arrow_upward' : 'arrow_downward';
        icon.closest('th').classList.add('sort-active');
    }

    // 정렬 적용
    applySorting();
}

function applySorting() {
    if (!sortState.field) {
        // 정렬이 없을 때는 필터만 적용 (renderTable은 applyGlobalFilters에서 호출됨)
        // 단, applyGlobalFilters 내부에서 호출된 경우를 방지하기 위해 체크
        if (!arguments[0] || arguments[0] !== 'skip-filter') {
            applyGlobalFilters();
        } else {
            renderTable();
        }
        return;
    }

    filteredPipelines.sort((a, b) => {
        let aVal = a[sortState.field];
        let bVal = b[sortState.field];

        // 필드별 매핑
        const fieldMap = {
            'lastDate': 'last_date',
            'product': 'product',
            'client': 'client_name',
            'campaign': 'campaign',
            'count': 'action_count',
            'followup': 'pipeline_followup',
            'owner': 'manager_name',
            'lastActionType': 'last_action_type',
            'currentStage': 'current_stage',
            'currentBudget': 'current_budget',
            'lastMemo': 'last_memo',
            'contactName': 'contact_name',
            'contactPhone': 'contact_phone',
            'contactemail': 'contact_email'
        };

        const actualField = fieldMap[sortState.field] || sortState.field;
        aVal = a[actualField];
        bVal = b[actualField];

        if (aVal === null || aVal === undefined) return 1;
        if (bVal === null || bVal === undefined) return -1;

        if (typeof aVal === 'number' && typeof bVal === 'number') {
            return sortState.direction === 'asc' ? aVal - bVal : bVal - aVal;
        }

        const aStr = String(aVal).toLowerCase();
        const bStr = String(bVal).toLowerCase();
        const comparison = aStr.localeCompare(bStr);
        return sortState.direction === 'asc' ? comparison : -comparison;
    });

    // 정렬 후에도 필터 조건 유지 (Active 섹션 등)
    // applyGlobalFilters를 호출하지 않고 바로 렌더링 (이미 필터링된 데이터를 정렬만 함)
    renderTable();
}

// 검색
function applyGlobalSearch() {
    applyGlobalFilters();
}

function clearGlobalSearch() {
    document.getElementById('global-search').value = '';
    applyGlobalFilters();
}

// 섹션 전환
function switchSection(section) {
    currentSection = section;
    
    // 표 깜빡임 효과 (섹션 전환 시각화)
    const tableContainer = document.querySelector('.table-container');
    if (tableContainer) {
        tableContainer.style.opacity = '0.3';
        tableContainer.style.transition = 'opacity 0.01s';
    }
    
    // 모든 섹션 숨기기
    document.getElementById('sec-board')?.classList.add('hidden');
    document.getElementById('sec-list-view')?.classList.add('hidden');
    
    // 활성 섹션 표시
    if (section === 'board') {
        document.getElementById('sec-board')?.classList.remove('hidden');
        // Board 섹션으로 전환 시 대시보드 업데이트
        updateDashboard();
    } else {
        document.getElementById('sec-list-view')?.classList.remove('hidden');
    }

    // 네비게이션 버튼 활성화
    document.querySelectorAll('.btn-toolbar').forEach(btn => {
        btn.classList.remove('active-board', 'active-active', 'active-pipe');
    });
    
    const navBtn = document.getElementById(`nav-${section}`);
    if (navBtn) {
        if (section === 'board') navBtn.classList.add('active-board');
        else if (section === 'active') navBtn.classList.add('active-active');
        else if (section === 'pipe') navBtn.classList.add('active-pipe');
    }

    // 리스트 뷰인 경우 데이터 로드
    if (section !== 'board') {
        loadPipelineData().then(() => {
            // 데이터 로드 후 표 다시 표시
            if (tableContainer) {
                setTimeout(() => {
                    tableContainer.style.opacity = '1';
                }, 100);
            }
        });
    } else {
        // board 섹션으로 전환 시 필터 초기화
        applyGlobalFilters();
        // 표 다시 표시
        if (tableContainer) {
            setTimeout(() => {
                tableContainer.style.opacity = '1';
            }, 100);
        }
    }
}

// Memo 모달
function showMemoModal(memo) {
    // 이스케이프된 문자 디코딩
    let decodedMemo = '';
    if (memo) {
        decodedMemo = memo
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\'/g, "'")
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
    }
    
    const memoContent = document.getElementById('memoContent');
    if (memoContent) {
        // 줄바꿈과 띄어쓰기를 그대로 유지
        // textContent를 사용하고 white-space: pre-wrap으로 처리
        memoContent.textContent = decodedMemo || '';
        memoContent.style.whiteSpace = 'pre-wrap'; // 줄바꿈과 공백 유지
        memoContent.style.wordWrap = 'break-word'; // 긴 단어 줄바꿈
    }
    const memoModal = document.getElementById('memoModal');
    if (memoModal) {
        memoModal.classList.remove('hidden');
    }
}

function closeMemoModal() {
    document.getElementById('memoModal').classList.add('hidden');
}

// 모달 토글
function toggleModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        const isHidden = modal.classList.contains('hidden');
        modal.classList.toggle('hidden');
        
        // 신규 등록 모달이 열릴 때 경고 메시지 및 체크박스 초기화
        if (modalId === 'newPipelineModal' && isHidden) {
            const warningDiv = document.getElementById('clientWarning');
            if (warningDiv) {
                warningDiv.classList.add('hidden');
                warningDiv.textContent = '';
            }
            const duplicateErrorDiv = document.getElementById('clientDuplicateError');
            if (duplicateErrorDiv) {
                duplicateErrorDiv.classList.add('hidden');
            }
            const mergeInfoDiv = document.getElementById('clientMergeInfo');
            if (mergeInfoDiv) {
                mergeInfoDiv.classList.add('hidden');
                mergeInfoDiv.textContent = '';
            }
            const submitBtn = document.getElementById('newPipelineSubmitBtn');
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.style.opacity = '1';
                submitBtn.style.cursor = 'pointer';
            }
            const followupCheckbox = document.getElementById('newPipelineFollowup');
            if (followupCheckbox) followupCheckbox.checked = false;
            // Action Date 오늘 날짜로 초기화
            const actionDateInput = document.getElementById('newPipelineActionDate');
            if (actionDateInput) {
                const today = new Date();
                actionDateInput.value = today.toISOString().split('T')[0];
            }
        }
        
        // 액션 기록 모달이 열릴 때 Action Date 오늘 날짜로 초기화
        if (modalId === 'recordActionModal' && isHidden) {
            const actionDateInput = document.getElementById('recordActionDate');
            if (actionDateInput) {
                const today = new Date();
                actionDateInput.value = today.toISOString().split('T')[0];
            }
        }
        
        // 액션 기록 모달이 열릴 때 드롭다운 닫힌 상태로 초기화
        if (modalId === 'recordActionModal' && isHidden) {
            // 모달이 열릴 때 (hidden이 제거될 때)
            const optionsList = document.getElementById('recordOptionsList');
            if (optionsList) {
                optionsList.classList.add('hidden');
            }
            // 입력 필드 초기화 (이미 비활성화되어 있으면 초기화하지 않음 - openRecordActionModal로 열린 경우)
            const searchInput = document.getElementById('recordSearchInput');
            const ownerSpan = document.getElementById('recordSearchOwner');
            const wrapper = document.getElementById('recordSearchInputWrapper');
            const selectedId = document.getElementById('recordSelectedId');
            if (searchInput && !searchInput.disabled) {
                // 비활성화되지 않은 경우에만 초기화 (일반 모달 열기)
                searchInput.value = '';
                searchInput.disabled = false;
                searchInput.style.cursor = '';
            }
            if (ownerSpan && !searchInput?.disabled) {
                ownerSpan.textContent = '';
            }
            if (wrapper && !searchInput?.disabled) {
                wrapper.style.backgroundColor = '';
                wrapper.style.color = '';
                wrapper.style.cursor = '';
            }
            if (selectedId && !searchInput?.disabled) {
                // 비활성화되지 않은 경우에만 초기화
                selectedId.value = '';
            }
            // F/up 필요 체크박스 초기화
            const followupCheckbox = document.getElementById('recordActionFollowup');
            if (followupCheckbox) followupCheckbox.checked = false;
        }
        
        // 액션 기록 모달이 닫힐 때 드롭다운 숨기기 및 파이프라인 선택 초기화
        if (modalId === 'recordActionModal' && !isHidden) {
            const optionsList = document.getElementById('recordOptionsList');
            if (optionsList) {
                optionsList.classList.add('hidden');
            }
            // 파이프라인 선택 상태 초기화
            const searchInput = document.getElementById('recordSearchInput');
            const ownerSpan = document.getElementById('recordSearchOwner');
            const wrapper = document.getElementById('recordSearchInputWrapper');
            const selectedId = document.getElementById('recordSelectedId');
            if (searchInput) {
                searchInput.value = '';
                searchInput.disabled = false;
                searchInput.style.cursor = '';
            }
            if (ownerSpan) {
                ownerSpan.textContent = '';
            }
            if (wrapper) {
                wrapper.style.backgroundColor = '';
                wrapper.style.color = '';
                wrapper.style.cursor = '';
            }
            if (selectedId) {
                selectedId.value = '';
            }
        }
        
        // 액션 수정 모달이 닫힐 때 파이프라인 선택 상태 초기화
        if (modalId === 'editActionModal' && !isHidden) {
            const searchInput = document.getElementById('editActionSearchInput');
            const ownerSpan = document.getElementById('editActionSearchOwner');
            const selectedId = document.getElementById('editActionSelectedId');
            const actionId = document.getElementById('editActionActionId');
            if (searchInput) {
                searchInput.value = '';
            }
            if (ownerSpan) {
                ownerSpan.textContent = '';
            }
            if (selectedId) {
                selectedId.value = '';
            }
            if (actionId) {
                actionId.value = '';
            }
        }
        
        // 수정 모달이 열릴 때 체크박스 초기화
        if (modalId === 'editModal' && isHidden) {
            const followupCheckbox = document.getElementById('editPipelineFollowup');
            if (followupCheckbox) followupCheckbox.checked = false;
            const mergeInfoDiv = document.getElementById('editClientMergeInfo');
            if (mergeInfoDiv) {
                mergeInfoDiv.classList.add('hidden');
            }
        }
        
        // 액션 수정 모달이 열릴 때는 체크박스를 초기화하지 않음 (데이터 로드 시 설정됨)
    }
}

// Client 편집 함수
async function editClient(uniqueId, currentName) {
    try {
        // 파이프라인 데이터 가져오기
        const client = window.supabaseClient;
        if (!client) {
            throw new Error('Supabase 클라이언트가 초기화되지 않았습니다.');
        }
        
        const { data, error } = await client
            .from('crm_client_pipeline')
            .select('*')
            .eq('unique_id', uniqueId)
            .single();

        if (error) throw error;

        // manager_id로 manager_name 가져오기
        let managerName = '';
        if (data.manager_id) {
            const { data: managerData, error: managerError } = await client
                .from('managers')
                .select('manager_name')
                .eq('id', data.manager_id)
                .single();
            
            if (!managerError && managerData) {
                managerName = managerData.manager_name;
            }
        }

        // 모달에 데이터 로드
        document.getElementById('editOriginalId').value = uniqueId;
        document.getElementById('editProduct').value = data.product || 'DNA';
        document.getElementById('editOwner').value = managerName;
        document.getElementById('editClient').value = data.client_name || '';
        document.getElementById('editCampaign').value = data.campaign || '';
        document.getElementById('editName').value = data.contact_name || '';
        document.getElementById('editPhone').value = data.contact_phone || '';
        document.getElementById('editemail').value = data.contact_email || '';
        document.getElementById('editPipelineFollowup').checked = data.pipeline_followup || false;

        // 중복 검사 메시지 초기화
        const mergeInfoDiv = document.getElementById('editClientMergeInfo');
        if (mergeInfoDiv) {
            mergeInfoDiv.classList.add('hidden');
        }

        // 모달 열기
        toggleModal('editModal');
    } catch (error) {
        console.error('편집 데이터 로드 오류:', error);
        alert('데이터를 불러오는 중 오류가 발생했습니다.');
    }
}

// 수정 모달 저장 함수
async function handleEditSubmit(event) {
    event.preventDefault();
    
    try {
        const client = window.supabaseClient;
        if (!client) {
            throw new Error('Supabase 클라이언트가 초기화되지 않았습니다.');
        }

        const form = event.target;
        const originalId = form.originalId.value;
        const product = form.product.value;
        const ownerName = form.owner.value.trim();
        const clientName = form.client.value.trim();
        const campaign = form.campaign.value.trim();
        const contactName = form.contactName.value.trim();
        const contactPhone = form.contactPhone.value.trim();
        const contactEmail = form.contactemail.value.trim();
        const pipelineFollowup = document.getElementById('editPipelineFollowup')?.checked || false;

        // Owner 이름으로 manager_id 찾기
        let managerId = null;
        if (ownerName) {
            const { data: managerData, error: managerError } = await client
                .from('managers')
                .select('id')
                .eq('manager_name', ownerName)
                .single();
            
            if (managerError || !managerData) {
                throw new Error(`담당자 "${ownerName}"를 찾을 수 없습니다.`);
            }
            managerId = managerData.id;
        }

        // 현재 파이프라인 정보 가져오기
        const { data: currentPipeline, error: currentError } = await client
            .from('crm_client_pipeline')
            .select('*')
            .eq('unique_id', originalId)
            .single();

        if (currentError) throw currentError;

        /**
         * 병합 로직 (Merge Logic)
         * 
         * 목적: 동일한 클라이언트와 캠페인을 가진 중복 파이프라인을 자동으로 병합하여 데이터 일관성 유지
         * 
         * 병합 규칙:
         * 1. 수정된 client_name과 campaign을 기준으로 기존 파이프라인 검색
         * 2. 일치하는 파이프라인이 있고, 현재 파이프라인보다 더 오래된 경우:
         *    - 오래된 파이프라인의 모든 액션(crm_client_actions)을 최신 파이프라인으로 이동
         *    - 오래된 파이프라인 삭제
         *    - 최신 파이프라인에 수정된 정보 업데이트
         * 3. 일치하는 파이프라인이 현재보다 더 최신인 경우:
         *    - 현재 파이프라인의 액션을 최신 파이프라인으로 이동
         *    - 현재 파이프라인 삭제
         *    - 최신 파이프라인에 수정된 정보 업데이트
         * 
         * 예시:
         * - 파이프라인 A (2024-01-01 생성): client="ABC", campaign="Campaign1"
         * - 파이프라인 B (2024-01-15 생성): client="ABC", campaign="Campaign1"
         * - 파이프라인 A를 수정하여 client="ABC", campaign="Campaign1"로 저장 시:
         *   → 파이프라인 A의 액션들이 파이프라인 B로 이동
         *   → 파이프라인 A 삭제
         *   → 파이프라인 B에 수정된 정보 업데이트
         */
        
        // 1. 수정된 client_name과 campaign으로 다른 파이프라인 검색
        const { data: duplicatePipelines, error: duplicateError } = await client
            .from('crm_client_pipeline')
            .select('*')
            .eq('client_name', clientName)
            .eq('campaign', campaign || '')
            .neq('unique_id', originalId);

        if (duplicateError) throw duplicateError;

        let targetUniqueId = originalId; // 병합 대상이 없으면 현재 파이프라인 ID 사용

        if (duplicatePipelines && duplicatePipelines.length > 0) {
            // 2. 모든 중복 파이프라인 중 가장 최신 파이프라인 찾기
            let newestPipeline = currentPipeline;
            const allPipelines = [currentPipeline, ...duplicatePipelines];
            
            for (const pipeline of allPipelines) {
                const pipelineCreatedAt = new Date(pipeline.created_at);
                const newestCreatedAt = new Date(newestPipeline.created_at);
                if (pipelineCreatedAt > newestCreatedAt) {
                    newestPipeline = pipeline;
                }
            }

            targetUniqueId = newestPipeline.unique_id;

            // 3. 병합 수행: 모든 중복 파이프라인의 액션을 최신 파이프라인으로 이동
            const pipelinesToMerge = allPipelines.filter(p => p.unique_id !== targetUniqueId);
            
            for (const pipeline of pipelinesToMerge) {
                // 각 파이프라인의 액션을 최신 파이프라인으로 이동
                const { error: updateActionsError } = await client
                    .from('crm_client_actions')
                    .update({ pipeline_id: targetUniqueId })
                    .eq('pipeline_id', pipeline.unique_id);

                if (updateActionsError) throw updateActionsError;

                // 중복 파이프라인 삭제
                const { error: deleteError } = await client
                    .from('crm_client_pipeline')
                    .delete()
                    .eq('unique_id', pipeline.unique_id);

                if (deleteError) throw deleteError;

                console.log(`병합 완료: ${pipeline.unique_id} -> ${targetUniqueId}`);
            }
            
            // 병합 완료 토스트 메시지
            showToast('PIPELINE 병합이 완료되었습니다');
        }

        // 4. 최신 파이프라인 업데이트
        // 파이프라인의 모든 액션 로그에서 action_followup 확인
        const { data: allActions, error: actionsError } = await client
            .from('crm_client_actions')
            .select('action_followup')
            .eq('pipeline_id', targetUniqueId);
        
        if (actionsError) throw actionsError;
        
        // action_followup이 하나라도 true면 pipeline_followup도 true
        // 단, 수정 모달에서는 체크박스가 disabled이므로 pipelineFollowup 값은 무시하고 action_followup만 확인
        const hasActionFollowup = allActions && allActions.length > 0 && allActions.some(a => a.action_followup === true || a.action_followup === 't' || a.action_followup === 1);
        const finalPipelineFollowup = hasActionFollowup; // 수정 모달에서는 action_followup만 확인
        
        const updateData = {
            product: product,
            client_name: clientName,
            campaign: campaign || null,
            manager_id: managerId,
            contact_name: contactName || null,
            contact_phone: contactPhone || null,
            contact_email: contactEmail || null,
            pipeline_followup: finalPipelineFollowup,
            updated_at: new Date().toISOString()
        };

        // unique_id가 변경된 경우 (병합으로 인해)
        if (targetUniqueId !== originalId) {
            // 새로운 unique_id로 업데이트
            updateData.unique_id = targetUniqueId;
            
            // 기존 파이프라인 삭제 후 새로 생성
            const { error: deleteOldError } = await client
                .from('crm_client_pipeline')
                .delete()
                .eq('unique_id', originalId);

            if (deleteOldError) throw deleteOldError;

            // 액션들의 pipeline_id도 업데이트
            const { error: updateActionsError } = await client
                .from('crm_client_actions')
                .update({ pipeline_id: targetUniqueId })
                .eq('pipeline_id', originalId);

            if (updateActionsError) throw updateActionsError;

            // 새 파이프라인 생성
            const { error: insertError } = await client
                .from('crm_client_pipeline')
                .insert({
                    ...updateData,
                    created_at: currentPipeline.created_at // 원래 생성 시간 유지
                });

            if (insertError) throw insertError;
        } else {
            // unique_id가 동일하면 일반 업데이트
            const { error: updateError } = await client
                .from('crm_client_pipeline')
                .update(updateData)
                .eq('unique_id', originalId);

            if (updateError) throw updateError;
        }

        // 모달 닫기
        toggleModal('editModal');
        
        // F/up 필요 체크박스 초기화
        const followupCheckbox = document.getElementById('editPipelineFollowup');
        if (followupCheckbox) followupCheckbox.checked = false;
        
        // 데이터 새로고침 (약간의 지연을 두어 DB 업데이트가 완료되도록 함)
        await new Promise(resolve => setTimeout(resolve, 100));
        await loadPipelineData();
        
        showToast('PIPELINE 정보가 수정되었습니다');
    } catch (error) {
        console.error('수정 오류:', error);
        alert(error.message || '파이프라인 정보 수정 중 오류가 발생했습니다.');
    }
}

// 액션 기록 모달 열기 (특정 파이프라인 선택)
function openRecordActionModal(uniqueId) {
    // 파이프라인 정보 가져오기
    const pipeline = allPipelines.find(p => p.unique_id === uniqueId);
    if (pipeline) {
        const displayName = `${pipeline.client_name}${pipeline.campaign ? ' x ' + pipeline.campaign : ''}`;
        const owner = pipeline.manager_name || '-';
        const searchInput = document.getElementById('recordSearchInput');
        const ownerSpan = document.getElementById('recordSearchOwner');
        const wrapper = document.getElementById('recordSearchInputWrapper');
        const selectedId = document.getElementById('recordSelectedId');
        if (searchInput) {
            searchInput.value = displayName;
            searchInput.disabled = true;
            searchInput.style.cursor = 'not-allowed';
        }
        if (ownerSpan) {
            ownerSpan.textContent = owner !== '-' ? owner : '';
        }
        if (wrapper) {
            wrapper.style.backgroundColor = '#f1f5f9';
            wrapper.style.color = '#94a3b8';
            wrapper.style.cursor = 'not-allowed';
        }
        if (selectedId) selectedId.value = uniqueId;
    }
    
    // 모달 열기
    toggleModal('recordActionModal');
}

// 액션 기록 모달의 파이프라인 드롭다운 표시
function showRecordDropdown() {
    const optionsList = document.getElementById('recordOptionsList');
    const searchInput = document.getElementById('recordSearchInput');
    
    if (!optionsList || !searchInput) return;
    
    // 비활성화된 경우 드롭다운 표시하지 않음
    if (searchInput.disabled) return;
    
    // 모든 파이프라인 목록 생성
    const options = allPipelines.map(p => {
        const displayName = `${p.client_name}${p.campaign ? ' x ' + p.campaign : ''}`;
        const owner = p.manager_name || '-';
        return {
            uniqueId: p.unique_id,
            displayName: displayName,
            owner: owner
        };
    });
    
    renderRecordDropdownOptions(options, '');
    optionsList.classList.remove('hidden');
}

// 액션 기록 모달의 파이프라인 드롭다운 필터링
function filterRecordDropdown() {
    const searchInput = document.getElementById('recordSearchInput');
    const optionsList = document.getElementById('recordOptionsList');
    
    if (!searchInput || !optionsList) return;
    
    const searchTerm = searchInput.value.toLowerCase();
    
    // 필터링된 파이프라인 목록 생성
    const filteredOptions = allPipelines
        .filter(p => {
            const displayName = `${p.client_name}${p.campaign ? ' x ' + p.campaign : ''}`.toLowerCase();
            const owner = (p.manager_name || '').toLowerCase();
            return displayName.includes(searchTerm) || owner.includes(searchTerm);
        })
        .map(p => {
            const displayName = `${p.client_name}${p.campaign ? ' x ' + p.campaign : ''}`;
            const owner = p.manager_name || '-';
            return {
                uniqueId: p.unique_id,
                displayName: displayName,
                owner: owner
            };
        });
    
    renderRecordDropdownOptions(filteredOptions, searchTerm);
}

// 액션 기록 모달의 파이프라인 옵션 렌더링
function renderRecordDropdownOptions(options, searchTerm) {
    const optionsList = document.getElementById('recordOptionsList');
    if (!optionsList) return;
    
    if (options.length === 0) {
        optionsList.innerHTML = '<li class="p-3 text-gray-400 text-xs text-center">검색 결과가 없습니다.</li>';
        return;
    }
    
    optionsList.innerHTML = options.map(option => {
        return `
            <li onclick="selectRecordPipeline('${option.uniqueId}', '${option.displayName.replace(/'/g, "\\'")}')" 
                class="p-3 hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-b-0">
                <div class="flex justify-between items-center">
                    <span class="text-xs text-gray-800">${option.displayName}</span>
                    <span class="text-xs text-gray-400">${option.owner}</span>
                </div>
            </li>
        `;
    }).join('');
}

// 액션 기록 모달에서 파이프라인 선택
function selectRecordPipeline(uniqueId, displayName) {
    const pipeline = allPipelines.find(p => p.unique_id === uniqueId);
    if (pipeline) {
        const owner = pipeline.manager_name || '-';
        const searchInput = document.getElementById('recordSearchInput');
        if (searchInput) {
            searchInput.value = `${displayName}`;
        }
        const selectedId = document.getElementById('recordSelectedId');
        if (selectedId) selectedId.value = uniqueId;
    }
    
    const optionsList = document.getElementById('recordOptionsList');
    if (optionsList) {
        optionsList.classList.add('hidden');
    }
}

// 외부 클릭 시 드롭다운 닫기
document.addEventListener('click', (e) => {
    const recordContainer = document.getElementById('record-dropdown-container');
    if (recordContainer && !recordContainer.contains(e.target)) {
        const optionsList = document.getElementById('recordOptionsList');
        if (optionsList) {
            optionsList.classList.add('hidden');
        }
    }
});

// 아코디언에서 특정 액션 편집 모달 열기
async function openEditActionModal(uniqueId, actionId) {
    try {
        const client = window.supabaseClient;
        if (!client) {
            throw new Error('Supabase 클라이언트가 초기화되지 않았습니다.');
        }

        // allPipelines에서 파이프라인 정보 가져오기 (manager_name 포함)
        const pipeline = allPipelines.find(p => p.unique_id === uniqueId);
        if (!pipeline) {
            throw new Error('파이프라인을 찾을 수 없습니다.');
        }

        // 특정 액션 로그 가져오기
        const { data: actionData, error: actionError } = await client
            .from('crm_client_actions')
            .select('*')
            .eq('id', actionId)
            .single();

        if (actionError) throw actionError;

        // 모달에 데이터 로드 ('클라이언트 x 캠페인'과 'Owner' 분리)
        const displayName = `${pipeline.client_name}${pipeline.campaign ? ' x ' + pipeline.campaign : ''}`;
        const owner = pipeline.manager_name || '-';
        const searchInput = document.getElementById('editActionSearchInput');
        const ownerSpan = document.getElementById('editActionSearchOwner');
        if (searchInput) {
            searchInput.value = displayName;
        }
        if (ownerSpan) {
            ownerSpan.textContent = owner !== '-' ? owner : '';
        }
        document.getElementById('editActionSelectedId').value = uniqueId;
        document.getElementById('editActionActionId').value = actionId; // actionId 저장
        
        document.getElementById('editActionActionType').value = actionData.action_type || 'email';
        document.getElementById('editActionStage').value = actionData.stage || 'contact';
        document.getElementById('editActionBudget').value = actionData.budget || '';
        document.getElementById('editActionMemo').value = actionData.memo || '';
        document.getElementById('editActionFollowup').checked = actionData.action_followup || false;
        const editActionDate = document.getElementById('editActionDate');
        if (editActionDate) {
            editActionDate.value = actionData.action_date || new Date().toISOString().split('T')[0];
        }

        // 모달 열기
        toggleModal('editActionModal');
    } catch (error) {
        console.error('액션 편집 데이터 로드 오류:', error);
        alert('데이터를 불러오는 중 오류가 발생했습니다.');
    }
}

// 마지막 액션 편집 모달 열기
async function editLastAction(uniqueId) {
    try {
        const client = window.supabaseClient;
        if (!client) {
            throw new Error('Supabase 클라이언트가 초기화되지 않았습니다.');
        }

        // allPipelines에서 파이프라인 정보 가져오기 (manager_name 포함)
        const pipeline = allPipelines.find(p => p.unique_id === uniqueId);
        if (!pipeline) {
            throw new Error('파이프라인을 찾을 수 없습니다.');
        }

        // 가장 마지막 액션 로그 가져오기
        const { data: lastAction, error: actionError } = await client
            .from('crm_client_actions')
            .select('*')
            .eq('pipeline_id', uniqueId)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        if (actionError && actionError.code !== 'PGRST116') {
            throw actionError;
        }

        // 모달에 데이터 로드 ('클라이언트 x 캠페인'과 'Owner' 분리)
        const displayName = `${pipeline.client_name}${pipeline.campaign ? ' x ' + pipeline.campaign : ''}`;
        const owner = pipeline.manager_name || '-';
        const searchInput = document.getElementById('editActionSearchInput');
        const ownerSpan = document.getElementById('editActionSearchOwner');
        if (searchInput) {
            searchInput.value = displayName;
        }
        if (ownerSpan) {
            ownerSpan.textContent = owner !== '-' ? owner : '';
        }
        document.getElementById('editActionSelectedId').value = uniqueId;
        
        if (lastAction) {
            document.getElementById('editActionActionType').value = lastAction.action_type || 'email';
            document.getElementById('editActionStage').value = lastAction.stage || 'contact';
            document.getElementById('editActionBudget').value = lastAction.budget || '';
            document.getElementById('editActionMemo').value = lastAction.memo || '';
            document.getElementById('editActionFollowup').checked = lastAction.action_followup || false;
            const editActionDate = document.getElementById('editActionDate');
            if (editActionDate) {
                editActionDate.value = lastAction.action_date || new Date().toISOString().split('T')[0];
            }
        } else {
            // 액션이 없는 경우 기본값
            document.getElementById('editActionActionType').value = 'email';
            document.getElementById('editActionStage').value = 'contact';
            document.getElementById('editActionBudget').value = '';
            document.getElementById('editActionMemo').value = '';
            document.getElementById('editActionFollowup').checked = false;
        }

        // 모달 열기
        toggleModal('editActionModal');
    } catch (error) {
        console.error('액션 편집 데이터 로드 오류:', error);
        alert('데이터를 불러오는 중 오류가 발생했습니다.');
    }
}

// 액션 편집 저장 함수
async function handleEditActionSubmit(event) {
    event.preventDefault();
    
    try {
        const client = window.supabaseClient;
        if (!client) {
            throw new Error('Supabase 클라이언트가 초기화되지 않았습니다.');
        }

        const form = event.target;
        const uniqueId = form.selectedId.value;
        const actionId = form.actionId?.value; // 아코디언에서 편집하는 경우 actionId가 있음
        const actionType = form.actionType.value;
        const stage = form.stage.value;
        const budget = parseInt(form.budget.value.replace(/,/g, '')) || 0;
        const memo = form.memo.value.trim();

        let targetAction;
        
        if (actionId) {
            // 아코디언에서 특정 액션 편집하는 경우
            const { data: actionData, error: findError } = await client
                .from('crm_client_actions')
                .select('id, action_followup')
                .eq('id', actionId)
                .single();

            if (findError) throw findError;
            if (!actionData) throw new Error('수정할 액션이 없습니다.');
            targetAction = actionData;
        } else {
            // 가장 마지막 액션 로그 가져오기 (원본 표에서 편집하는 경우)
            const { data: lastAction, error: findError } = await client
                .from('crm_client_actions')
                .select('id, action_followup, action_type, stage, budget, memo')
                .eq('pipeline_id', uniqueId)
                .order('created_at', { ascending: false })
                .limit(1)
                .single();

            if (findError && findError.code !== 'PGRST116') {
                throw findError;
            }

            if (!lastAction) {
                throw new Error('수정할 액션이 없습니다.');
            }
            targetAction = lastAction;
        }

        // F/up 필요 체크박스 값 가져오기
        const actionFollowup = document.getElementById('editActionFollowup')?.checked || false;

        // Action Date 가져오기 (입력된 값이 있으면 사용, 없으면 오늘 날짜)
        const formActionDate = form.actionDate?.value;
        const actionDate = formActionDate || new Date().toISOString().split('T')[0]; // YYYY-MM-DD 형식

        // 액션 업데이트
        const { error: updateError } = await client
            .from('crm_client_actions')
            .update({
                action_type: actionType,
                stage: stage || null,
                budget: budget,
                memo: memo || null,
                action_followup: actionFollowup,
                action_date: actionDate,
                updated_at: new Date().toISOString()
            })
            .eq('id', targetAction.id);

        if (updateError) throw updateError;

        // 파이프라인의 모든 액션 로그에서 action_followup 확인하여 pipeline_followup 업데이트
        const { data: allActions, error: actionsError } = await client
            .from('crm_client_actions')
            .select('action_followup')
            .eq('pipeline_id', uniqueId);
        
        if (actionsError) throw actionsError;
        
        // action_followup이 하나라도 true면 pipeline_followup도 true, 모두 false면 false
        const hasActionFollowup = allActions && allActions.length > 0 && allActions.some(a => a.action_followup === true || a.action_followup === 't' || a.action_followup === 1);
        
        // pipeline_followup 업데이트
        const { error: pipelineUpdateError } = await client
            .from('crm_client_pipeline')
            .update({ pipeline_followup: hasActionFollowup })
            .eq('unique_id', uniqueId);
        
        if (pipelineUpdateError) throw pipelineUpdateError;

        // 모달 닫기
        toggleModal('editActionModal');
        
        // 데이터 새로고침 (약간의 지연을 두어 DB 업데이트가 완료되도록 함)
        await new Promise(resolve => setTimeout(resolve, 100));
        await loadPipelineData();
        
        showToast('SALES ACTION 정보가 수정되었습니다');
    } catch (error) {
        console.error('액션 수정 오류:', error);
        alert(error.message || '액션 정보 수정 중 오류가 발생했습니다.');
    }
}

// 신규 파이프라인 등록 함수
async function handleNewPipeline(event) {
    event.preventDefault();
    
    try {
        const client = window.supabaseClient;
        if (!client) {
            throw new Error('Supabase 클라이언트가 초기화되지 않았습니다.');
        }

        const form = event.target;
        const product = form.product.value;
        const ownerName = form.owner.value.trim();
        const clientName = form.client.value.trim();
        const campaign = form.campaign.value.trim();
        const contactName = form.contactName.value.trim();
        const contactPhone = form.contactPhone.value.trim();
        const contactEmail = form.contactemail.value.trim();
        const actionType = form.actionType.value;
        const stage = form.stage.value;
        const budget = parseInt(form.budget.value.replace(/,/g, '')) || 0;
        const memo = form.memo.value.trim();
        const pipelineFollowup = document.getElementById('newPipelineFollowup')?.checked || false;

        // Owner 이름으로 manager_id 찾기
        let managerId = null;
        if (ownerName) {
            const { data: managerData, error: managerError } = await client
                .from('managers')
                .select('id')
                .eq('manager_name', ownerName)
                .single();
            
            if (managerError || !managerData) {
                throw new Error(`담당자 "${ownerName}"를 찾을 수 없습니다.`);
            }
            managerId = managerData.id;
        }

        // unique_id 생성 (P- + 타임스탬프)
        const uniqueId = `P-${Date.now()}`;

        // 액션 followup 결정 (체크박스가 체크되면 true, 아니면 stage가 propose인 경우만 true)
        const followupChecked = document.getElementById('newPipelineFollowup')?.checked || false;
        const actionFollowup = followupChecked || stage === 'propose';

        // 파이프라인 데이터 생성
        const { data: pipelineData, error: pipelineError } = await client
            .from('crm_client_pipeline')
            .insert({
                unique_id: uniqueId,
                product: product,
                client_name: clientName,
                campaign: campaign || null,
                manager_id: managerId,
                contact_name: contactName || null,
                contact_phone: contactPhone || null,
                contact_email: contactEmail || null,
                pipeline_followup: pipelineFollowup || actionFollowup,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .select()
            .single();

        if (pipelineError) throw pipelineError;

        // 액션 데이터 생성
        const { error: actionError } = await client
            .from('crm_client_actions')
            .insert({
                pipeline_id: uniqueId,
                action_type: actionType,
                stage: stage || null,
                budget: budget,
                memo: memo || null,
                action_followup: actionFollowup,
                action_date: form.actionDate?.value || new Date().toISOString().split('T')[0],
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });

        if (actionError) throw actionError;

        // 파이프라인의 모든 액션 로그에서 action_followup 확인하여 pipeline_followup 업데이트
        const { data: allActions, error: actionsError } = await client
            .from('crm_client_actions')
            .select('action_followup')
            .eq('pipeline_id', uniqueId);
        
        if (actionsError) throw actionsError;
        
        // action_followup이 하나라도 true면 pipeline_followup도 true, 모두 false면 false
        const hasActionFollowup = allActions && allActions.length > 0 && allActions.some(a => a.action_followup === true || a.action_followup === 't' || a.action_followup === 1);
        
        // pipeline_followup 업데이트
        const { error: pipelineUpdateError } = await client
            .from('crm_client_pipeline')
            .update({ pipeline_followup: hasActionFollowup })
            .eq('unique_id', uniqueId);
        
        if (pipelineUpdateError) throw pipelineUpdateError;

        // 모달 닫기
        toggleModal('newPipelineModal');
        
        // 폼 초기화
        form.reset();
        // 경고 메시지 숨기기
        const warningDiv = document.getElementById('clientWarning');
        if (warningDiv) {
            warningDiv.classList.add('hidden');
            warningDiv.textContent = '';
        }
        const mergeInfoDiv = document.getElementById('clientMergeInfo');
        if (mergeInfoDiv) {
            mergeInfoDiv.classList.add('hidden');
            mergeInfoDiv.textContent = '';
        }
        const duplicateErrorDiv = document.getElementById('clientDuplicateError');
        if (duplicateErrorDiv) {
            duplicateErrorDiv.classList.add('hidden');
        }
        const submitBtn = document.getElementById('newPipelineSubmitBtn');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.style.opacity = '1';
            submitBtn.style.cursor = 'pointer';
        }
        // F/up 필요 체크박스 초기화
        const followupCheckbox = document.getElementById('newPipelineFollowup');
        if (followupCheckbox) followupCheckbox.checked = false;
        // Owner 기본값 다시 설정
        loadOwnerOptions();
        
        // 데이터 새로고침 (약간의 지연을 두어 DB 업데이트가 완료되도록 함)
        await new Promise(resolve => setTimeout(resolve, 100));
        await loadPipelineData();
        
        showToast('파이프라인이 등록되었습니다.');
    } catch (error) {
        console.error('파이프라인 등록 오류:', error);
        alert(error.message || '파이프라인 등록 중 오류가 발생했습니다.');
    }
}

// 액션 기록 저장 함수
async function handleRecordAction(event) {
    event.preventDefault();
    
    try {
        const client = window.supabaseClient;
        if (!client) {
            throw new Error('Supabase 클라이언트가 초기화되지 않았습니다.');
        }

        const form = event.target;
        const uniqueId = form.selectedId.value;
        const actionType = form.actionType.value;
        const stage = form.stage.value;
        const budget = parseInt(form.budget.value.replace(/,/g, '')) || 0;
        const memo = form.memo.value.trim();
        const actionFollowup = document.getElementById('recordActionFollowup')?.checked || stage === 'propose';

        if (!uniqueId) {
            throw new Error('파이프라인을 선택해주세요.');
        }

        // 액션 데이터 생성
        const { error: actionError } = await client
            .from('crm_client_actions')
            .insert({
                pipeline_id: uniqueId,
                action_type: actionType,
                stage: stage || null,
                budget: budget,
                memo: memo || null,
                action_followup: actionFollowup,
                action_date: form.actionDate?.value || new Date().toISOString().split('T')[0],
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });

        if (actionError) throw actionError;

        // 파이프라인의 모든 액션 로그에서 action_followup 확인하여 pipeline_followup 업데이트
        const { data: allActions, error: actionsError } = await client
            .from('crm_client_actions')
            .select('action_followup')
            .eq('pipeline_id', uniqueId);
        
        if (actionsError) throw actionsError;
        
        const hasActionFollowup = allActions && allActions.length > 0 && allActions.some(a => a.action_followup === true || a.action_followup === 't' || a.action_followup === 1);
        
        // pipeline_followup 업데이트
        const { error: pipelineUpdateError } = await client
            .from('crm_client_pipeline')
            .update({ pipeline_followup: hasActionFollowup })
            .eq('unique_id', uniqueId);
        
        if (pipelineUpdateError) throw pipelineUpdateError;

        // 모달 닫기
        toggleModal('recordActionModal');
        
        // 폼 초기화
        form.reset();
        const searchInput = document.getElementById('recordSearchInput');
        const selectedId = document.getElementById('recordSelectedId');
        if (searchInput) {
            searchInput.value = '';
            searchInput.disabled = false;
            searchInput.style.backgroundColor = '';
            searchInput.style.color = '';
        }
        if (selectedId) selectedId.value = '';
        // F/up 필요 체크박스 초기화
        const followupCheckbox = document.getElementById('recordActionFollowup');
        if (followupCheckbox) followupCheckbox.checked = false;
        
        // 데이터 새로고침 (약간의 지연을 두어 DB 업데이트가 완료되도록 함)
        await new Promise(resolve => setTimeout(resolve, 100));
        await loadPipelineData();
        
        showToast('액션이 기록되었습니다.');
    } catch (error) {
        console.error('액션 기록 오류:', error);
        alert(error.message || '액션 기록 중 오류가 발생했습니다.');
    }
}

// 실시간 클라이언트 중복 검사 (Debounce 적용)
let debounceTimer = null;
function checkDuplicateClient(clientName) {
    // 기존 타이머 취소
    clearTimeout(debounceTimer);
    
    const warningDiv = document.getElementById('clientWarning');
    if (!warningDiv) return;
    
    // 입력값이 2글자 미만이면 경고 숨기기
    if (!clientName || clientName.trim().length < 2) {
        warningDiv.classList.add('hidden');
        warningDiv.textContent = '';
        // 병합 안내도 숨기기
        const mergeInfoDiv = document.getElementById('clientMergeInfo');
        if (mergeInfoDiv) {
            mergeInfoDiv.classList.add('hidden');
            mergeInfoDiv.textContent = '';
        }
        return;
    }
    
    // Debounce: 300ms 후 검사 실행
    debounceTimer = setTimeout(() => {
        const trimmedName = clientName.trim().toLowerCase();
        
        // 클라이언트 사이드에서 유사한 클라이언트 검색
        const similarClients = allPipelines.filter(p => {
            if (!p.client_name) return false;
            const existingName = p.client_name.toLowerCase();
            
            // 정확히 일치하거나 부분 일치하는 경우
            return existingName === trimmedName || 
                   existingName.includes(trimmedName) || 
                   trimmedName.includes(existingName);
        });
        
        if (similarClients.length > 0) {
            // 중복/유사한 클라이언트 발견
            const uniqueClients = [...new Set(similarClients.map(p => p.client_name))];
            let warningMessage = '유사한 클라이언트가 존재합니다: ';
            
            if (uniqueClients.length === 1) {
                warningMessage += uniqueClients[0];
            } else if (uniqueClients.length <= 3) {
                warningMessage += uniqueClients.join(', ');
            } else {
                warningMessage += uniqueClients.slice(0, 3).join(', ') + ` 외 ${uniqueClients.length - 3}개`;
            }
            
            warningDiv.textContent = warningMessage;
            warningDiv.classList.remove('hidden');
        } else {
            // 중복 없음
            warningDiv.classList.add('hidden');
            warningDiv.textContent = '';
        }
        
        // 클라이언트+캠페인 중복 검사도 실행
        checkDuplicatePipeline();
    }, 300);
}

// 클라이언트+캠페인 중복 검사 (신규 등록 모달)
let debounceTimerPipeline = null;
function checkDuplicatePipeline() {
    clearTimeout(debounceTimerPipeline);
    
    const mergeInfoDiv = document.getElementById('clientMergeInfo');
    const duplicateErrorDiv = document.getElementById('clientDuplicateError');
    const submitBtn = document.getElementById('newPipelineSubmitBtn');
    
    if (!mergeInfoDiv || !duplicateErrorDiv) return;
    
    const clientName = document.getElementById('newPipelineClient')?.value.trim() || '';
    const campaign = document.getElementById('newPipelineCampaign')?.value.trim() || '';
    
    if (!clientName || clientName.length < 2) {
        mergeInfoDiv.classList.add('hidden');
        mergeInfoDiv.textContent = '';
        duplicateErrorDiv.classList.add('hidden');
        if (submitBtn) submitBtn.disabled = false;
        return;
    }
    
    debounceTimerPipeline = setTimeout(() => {
        // 클라이언트와 캠페인이 정확히 일치하는 파이프라인 검색
        const duplicatePipelines = allPipelines.filter(p => {
            const pClient = (p.client_name || '').trim();
            const pCampaign = (p.campaign || '').trim();
            return pClient === clientName && pCampaign === campaign;
        });
        
        if (duplicatePipelines.length > 0) {
            // 신규 등록 모달: 빨간색 에러 메시지 표시 및 등록 버튼 비활성화
            duplicateErrorDiv.classList.remove('hidden');
            mergeInfoDiv.classList.add('hidden');
            mergeInfoDiv.textContent = '';
            // '유사한 클라이언트가 존재합니다' 메시지 숨기기
            const warningDiv = document.getElementById('clientWarning');
            if (warningDiv) {
                warningDiv.classList.add('hidden');
                warningDiv.textContent = '';
            }
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.style.opacity = '0.5';
                submitBtn.style.cursor = 'not-allowed';
            }
        } else {
            duplicateErrorDiv.classList.add('hidden');
            mergeInfoDiv.classList.add('hidden');
            mergeInfoDiv.textContent = '';
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.style.opacity = '1';
                submitBtn.style.cursor = 'pointer';
            }
        }
    }, 300);
}

// 수정 모달 클라이언트+캠페인 중복 검사
let debounceTimerEditPipeline = null;
function checkEditDuplicatePipeline() {
    clearTimeout(debounceTimerEditPipeline);
    
    const mergeInfoDiv = document.getElementById('editClientMergeInfo');
    if (!mergeInfoDiv) return;
    
    const originalId = document.getElementById('editOriginalId')?.value || '';
    const clientName = document.getElementById('editClient')?.value.trim() || '';
    const campaign = document.getElementById('editCampaign')?.value.trim() || '';
    
    if (!clientName || clientName.length < 2) {
        mergeInfoDiv.classList.add('hidden');
        return;
    }
    
    debounceTimerEditPipeline = setTimeout(() => {
        // 클라이언트와 캠페인이 정확히 일치하는 파이프라인 검색 (현재 파이프라인 제외)
        const duplicatePipelines = allPipelines.filter(p => {
            if (p.unique_id === originalId) return false;
            const pClient = (p.client_name || '').trim();
            const pCampaign = (p.campaign || '').trim();
            return pClient === clientName && pCampaign === campaign;
        });
        
        if (duplicatePipelines.length > 0) {
            // 수정 모달: 파란색 안내 메시지 표시 (유사한 클라이언트 경고는 숨김)
            mergeInfoDiv.classList.remove('hidden');
            const warningDiv = document.getElementById('clientWarning');
            if (warningDiv) {
                warningDiv.classList.add('hidden');
            }
        } else {
            mergeInfoDiv.classList.add('hidden');
        }
    }, 300);
}

// ==========================================
// Board 섹션 관련 함수들 (reference_script.js에서 가져옴)
// ==========================================

// 대시보드 업데이트 함수
function updateDashboard() {
    if (!fullHistoryCache || fullHistoryCache.length === 0) {
        // 데이터가 없으면 0으로 초기화
        initializeDashboardCards();
        return;
    }

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); // 0-based (0 = January)
    
    // 이번 달의 시작일과 종료일
    const currentMonthStart = new Date(currentYear, currentMonth, 1);
    const currentMonthEnd = new Date(currentYear, currentMonth + 1, 0, 23, 59, 59);
    
    // 지난 3개월 계산 (이번 달 제외)
    const months = [];
    for (let i = 1; i <= 3; i++) {
        const monthDate = new Date(currentYear, currentMonth - i, 1);
        months.push({
            year: monthDate.getFullYear(),
            month: monthDate.getMonth(),
            start: new Date(monthDate.getFullYear(), monthDate.getMonth(), 1),
            end: new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0, 23, 59, 59)
        });
    }
    months.reverse(); // 오래된 순서로 정렬

    // 1. 상단 카드 데이터 계산 (이번 달)
    const currentMonthLogs = fullHistoryCache.filter(log => {
        if (!log.date) return false;
        const logDate = new Date(log.date + 'T00:00:00');
        return logDate >= currentMonthStart && logDate <= currentMonthEnd;
    });

    // Contacts: Email + Cold Call
    const contacts = currentMonthLogs.filter(log => 
        log.action === 'Email' || log.action === 'Cold Call'
    ).length;

    // Meetings: Meeting
    const meetings = currentMonthLogs.filter(log => 
        log.action === 'Meeting'
    ).length;

    // Negotiations: Lead + Negotiation
    const negotiations = currentMonthLogs.filter(log => 
        log.stage === 'Lead' || log.stage === 'Negotiation'
    ).length;

    // Closed Won
    const closedWon = currentMonthLogs.filter(log => 
        log.stage === 'Closed Won'
    ).length;

    // Budget Sum
    const budgetSum = currentMonthLogs.reduce((sum, log) => {
        return sum + (log.budget || 0);
    }, 0);

    // Won Budget
    const wonBudget = currentMonthLogs
        .filter(log => log.stage === 'Closed Won')
        .reduce((sum, log) => sum + (log.budget || 0), 0);

    // 카드 업데이트
    document.getElementById('sum-contact').textContent = contacts.toLocaleString();
    document.getElementById('sum-meeting').textContent = meetings.toLocaleString();
    document.getElementById('sum-nego').textContent = negotiations.toLocaleString();
    document.getElementById('sum-won').textContent = closedWon.toLocaleString();
    document.getElementById('sum-budget').textContent = budgetSum.toLocaleString();
    document.getElementById('sum-won-budget').textContent = wonBudget.toLocaleString();

    // 2. Trend 그래프 데이터 (지난 3개월)
    const trendData = months.map(month => {
        const monthLogs = fullHistoryCache.filter(log => {
            if (!log.date) return false;
            const logDate = new Date(log.date + 'T00:00:00');
            return logDate >= month.start && logDate <= month.end;
        });

        return {
            month: `${month.year}-${String(month.month + 1).padStart(2, '0')}`,
            contacts: monthLogs.filter(l => l.action === 'Email' || l.action === 'Cold Call').length,
            meetings: monthLogs.filter(l => l.action === 'Meeting').length,
            negotiations: monthLogs.filter(l => l.stage === 'Lead' || l.stage === 'Negotiation').length,
            closedWon: monthLogs.filter(l => l.stage === 'Closed Won').length,
            wonBudget: monthLogs.filter(l => l.stage === 'Closed Won').reduce((sum, l) => sum + (l.budget || 0), 0)
        };
    });

    // Trend 그래프 렌더링 (지난 3개월 데이터)
    renderTrendCharts(trendData, currentMonthLogs);

    // 3. 미팅 전환율 계산 (이번 달 + 지난 2개월)
    const meetingConversionMonths = [];
    for (let i = 0; i < 3; i++) {
        const monthDate = new Date(currentYear, currentMonth - i, 1);
        meetingConversionMonths.push({
            year: monthDate.getFullYear(),
            month: monthDate.getMonth(),
            start: new Date(monthDate.getFullYear(), monthDate.getMonth(), 1),
            end: new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0, 23, 59, 59)
        });
    }
    meetingConversionMonths.reverse();
    const meetingConversionData = calculateMeetingConversionRate(meetingConversionMonths);
    renderMeetingConversionChart(meetingConversionData, meetingConversionData[2].rate);

    // 4. 부킹율 계산 (이번 달 + 지난 2개월)
    const bookingRateMonths = [];
    for (let i = 0; i < 3; i++) {
        const monthDate = new Date(currentYear, currentMonth - i, 1);
        bookingRateMonths.push({
            year: monthDate.getFullYear(),
            month: monthDate.getMonth(),
            start: new Date(monthDate.getFullYear(), monthDate.getMonth(), 1),
            end: new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0, 23, 59, 59)
        });
    }
    bookingRateMonths.reverse();
    const bookingRateData = calculateBookingRate(bookingRateMonths);
    renderBookingRateChart(bookingRateData, bookingRateData[2].rate);
}

// 미팅 전환율 계산
function calculateMeetingConversionRate(months) {
    return months.map(month => {
        const monthLogs = fullHistoryCache.filter(log => {
            if (!log.date) return false;
            const logDate = new Date(log.date + 'T00:00:00');
            return logDate >= month.start && logDate <= month.end;
        });

        // 파이프라인별로 그룹화
        const pipelineLogs = {};
        monthLogs.forEach(log => {
            if (!pipelineLogs[log.uniqueId]) {
                pipelineLogs[log.uniqueId] = [];
            }
            pipelineLogs[log.uniqueId].push(log);
        });

        // 전체 Email + Cold Call 수
        const totalEmailColdCall = monthLogs.filter(l => 
            l.action === 'Email' || l.action === 'Cold Call'
        ).length;

        // Meeting이 있고, 그보다 과거에 Email 또는 Cold Call이 있었던 파이프라인 수
        const convertedPipelines = new Set();
        
        Object.keys(pipelineLogs).forEach(pid => {
            const logs = pipelineLogs[pid].sort((a, b) => {
                const dateA = new Date(a.date + 'T00:00:00');
                const dateB = new Date(b.date + 'T00:00:00');
                return dateA - dateB;
            });
            
            // Meeting이 있는지 확인
            const meetingIndex = logs.findIndex(l => l.action === 'Meeting');
            if (meetingIndex > 0) {
                // Meeting보다 과거에 Email 또는 Cold Call이 있는지 확인
                const hasEmailOrColdCall = logs.slice(0, meetingIndex).some(l => 
                    l.action === 'Email' || l.action === 'Cold Call'
                );
                if (hasEmailOrColdCall) {
                    convertedPipelines.add(pid);
                }
            }
        });

        const rate = totalEmailColdCall > 0 
            ? (convertedPipelines.size / totalEmailColdCall) * 100 
            : 0;

        return {
            month: `${month.year}-${String(month.month + 1).padStart(2, '0')}`,
            rate: Math.round(rate * 10) / 10 // 소수 첫째자리까지
        };
    });
}

// 부킹율 계산
function calculateBookingRate(months) {
    return months.map(month => {
        const monthLogs = fullHistoryCache.filter(log => {
            if (!log.date) return false;
            const logDate = new Date(log.date + 'T00:00:00');
            return logDate >= month.start && logDate <= month.end;
        });

        // 이번 달에 Closed Won이 생성된 파이프라인 찾기
        const closedWonLogs = monthLogs.filter(l => l.stage === 'Closed Won');
        
        // Closed Won 생성일 14일 전에 Lead 또는 Negotiation이 있었던 수
        let qualifiedCount = 0;
        closedWonLogs.forEach(closedWonLog => {
            if (!closedWonLog.date) return;
            const closedWonDate = new Date(closedWonLog.date + 'T00:00:00');
            const fourteenDaysAgo = new Date(closedWonDate);
            fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
            // 시간을 00:00:00으로 설정하여 날짜만 비교
            fourteenDaysAgo.setHours(0, 0, 0, 0);
            closedWonDate.setHours(0, 0, 0, 0);
            
            // 같은 파이프라인의 로그 중 Closed Won 날짜 14일 전에 Lead 또는 Negotiation이 있는지 확인
            const pipelineLogs = fullHistoryCache.filter(l => 
                l.uniqueId === closedWonLog.uniqueId && l.date
            );
            
            const hasLeadOrNego = pipelineLogs.some(l => {
                const logDate = new Date(l.date + 'T00:00:00');
                logDate.setHours(0, 0, 0, 0);
                return logDate >= fourteenDaysAgo && 
                       logDate < closedWonDate && 
                       (l.stage === 'Lead' || l.stage === 'Negotiation');
            });
            
            if (hasLeadOrNego) {
                qualifiedCount++;
            }
        });

        // 이번 달에 발생한 Lead, Negotiation의 개수
        const totalLeadNego = monthLogs.filter(l => 
            l.stage === 'Lead' || l.stage === 'Negotiation'
        ).length;

        const rate = totalLeadNego > 0 
            ? (qualifiedCount / totalLeadNego) * 100 
            : 0;

        return {
            month: `${month.year}-${String(month.month + 1).padStart(2, '0')}`,
            rate: Math.round(rate * 10) / 10 // 소수 첫째자리까지
        };
    });
}

// Trend 그래프 렌더링
function renderTrendCharts(trendData, currentMonthLogs) {
    const labels = trendData.map(d => d.month);
    
    // 이번 달 데이터 계산 (하단 카드용)
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const currentMonthStart = new Date(currentYear, currentMonth, 1);
    const currentMonthEnd = new Date(currentYear, currentMonth + 1, 0, 23, 59, 59);
    
    const currentMonthData = {
        contacts: currentMonthLogs.filter(l => l.action === 'Email' || l.action === 'Cold Call').length,
        meetings: currentMonthLogs.filter(l => l.action === 'Meeting').length,
        negotiations: currentMonthLogs.filter(l => l.stage === 'Lead' || l.stage === 'Negotiation').length,
        closedWon: currentMonthLogs.filter(l => l.stage === 'Closed Won').length,
        wonBudget: currentMonthLogs.filter(l => l.stage === 'Closed Won').reduce((sum, l) => sum + (l.budget || 0), 0)
    };
    
    // Contact Trend (막대 그래프)
    renderBarChart('chart-contact', labels, trendData.map(d => d.contacts), '#64748b', 'Contacts');
    document.getElementById('card-contact').textContent = currentMonthData.contacts.toLocaleString();
    
    // Meeting Trend (막대 그래프)
    renderBarChart('chart-meeting', labels, trendData.map(d => d.meetings), '#2563eb', 'Meetings');
    document.getElementById('card-meeting').textContent = currentMonthData.meetings.toLocaleString();
    
    // Negotiation Trend (막대 그래프)
    renderBarChart('chart-nego', labels, trendData.map(d => d.negotiations), '#eab308', 'Negotiations');
    document.getElementById('card-nego').textContent = currentMonthData.negotiations.toLocaleString();
    
    // Closed Won Trend (막대 그래프)
    renderBarChart('chart-won', labels, trendData.map(d => d.closedWon), '#16a34a', 'Closed Won');
    document.getElementById('card-won').textContent = currentMonthData.closedWon.toLocaleString();
    
    // Won Budget Trend (막대 그래프, 만원 단위)
    renderBarChart('chart-won-budget', labels, trendData.map(d => d.wonBudget), '#10b981', 'Won Budget', true);
    const wonBudgetInMan = Math.round(currentMonthData.wonBudget / 10000 * 10) / 10;
    document.getElementById('card-won-budget').textContent = wonBudgetInMan > 0 ? `${wonBudgetInMan}만원` : '0';
}

// 미팅 전환율 그래프 렌더링
function renderMeetingConversionChart(data, currentRate) {
    const labels = data.map(d => d.month);
    const rates = data.map(d => d.rate);
    
    renderChart('chart-rate-meeting', labels, rates, '#6366f1', 'Meeting Conversion Rate', '%');
    document.getElementById('card-rate-meeting').textContent = currentRate.toFixed(1) + '%';
}

// 부킹율 그래프 렌더링
function renderBookingRateChart(data, currentRate) {
    const labels = data.map(d => d.month);
    const rates = data.map(d => d.rate);
    
    renderChart('chart-rate-booking', labels, rates, '#f43f5e', 'Booking Rate', '%');
    document.getElementById('card-rate-booking').textContent = currentRate.toFixed(1) + '%';
}

// 막대 그래프 렌더링 함수
function renderBarChart(canvasId, labels, data, color, label, isWonBudget = false) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    
    // 기존 차트가 있으면 제거
    if (window[canvasId + 'Chart']) {
        window[canvasId + 'Chart'].destroy();
    }
    
    // Won Budget인 경우 데이터를 10,000으로 나누기
    const processedData = isWonBudget ? data.map(d => Math.round(d / 10000 * 10) / 10) : data;
    
    const chart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: label,
                data: processedData,
                backgroundColor: color + '80',
                borderColor: color,
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    padding: 12,
                    titleFont: { size: 0 },
                    bodyFont: { size: 12 },
                    displayColors: false,
                    callbacks: {
                        title: function() { return ''; },
                        label: function(context) {
                            if (isWonBudget) {
                                const value = context.parsed.y;
                                return value > 0 ? `${value}만원` : '0';
                            }
                            return context.parsed.y.toLocaleString();
                        }
                    },
                    intersect: false,
                    axis: 'x',
                    xAlign: 'center',
                    yAlign: 'bottom',
                    caretSize: 0,
                    caretPadding: 8,
                    cornerRadius: 6,
                    titleSpacing: 0,
                    titleMarginBottom: 0
                },
                datalabels: {
                    anchor: 'end',
                    align: 'top',
                    offset: 2,
                    color: color,
                    font: {
                        size: 10,
                        weight: 'bold'
                    },
                    formatter: function(value) {
                        if (isWonBudget) {
                            return value > 0 ? `${value}만원` : '';
                        }
                        return value.toLocaleString();
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    suggestedMax: (() => {
                        const maxValue = Math.max(...processedData);
                        // 데이터 레이블이 잘리지 않도록 최대값의 20% 여백 추가
                        return maxValue > 0 ? maxValue * 1.2 : 10;
                    })(),
                    ticks: {
                        font: { size: 10 },
                        callback: function(value) {
                            if (isWonBudget) {
                                return value > 0 ? `${value}만원` : '0';
                            }
                            return value.toLocaleString();
                        }
                    },
                    grid: {
                        color: '#f1f5f9'
                    }
                },
                x: {
                    ticks: {
                        font: { size: 10 }
                    },
                    grid: {
                        display: false
                    }
                }
            },
            interaction: {
                mode: 'index',
                intersect: false,
                axis: 'x'
            },
            onHover: (event, activeElements, chart) => {
                if (activeElements && activeElements.length > 0) {
                    canvas.style.cursor = 'pointer';
                } else {
                    canvas.style.cursor = 'default';
                }
            },
            elements: {
                bar: {
                    borderSkipped: false
                }
            }
        },
        plugins: [ChartDataLabels]
    });
    
    // 툴팁 범위를 2.5배로 확대하기 위한 커스텀 이벤트 핸들러
    canvas.addEventListener('mousemove', function(e) {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const chartArea = chart.chartArea;
        const barWidth = (chartArea.right - chartArea.left) / labels.length;
        const expandedRange = barWidth * 2.5;
        
        let foundIndex = -1;
        labels.forEach((label, index) => {
            const barCenter = chartArea.left + (index + 0.5) * barWidth;
            if (Math.abs(x - barCenter) < expandedRange / 2) {
                foundIndex = index;
            }
        });
        
        if (foundIndex >= 0) {
            const meta = chart.getDatasetMeta(0);
            const point = meta.data[foundIndex];
            if (point) {
                chart.setActiveElements([{
                    datasetIndex: 0,
                    index: foundIndex
                }]);
                chart.update('none');
            }
        } else {
            chart.setActiveElements([]);
            chart.update('none');
        }
    });
    
    window[canvasId + 'Chart'] = chart;
}

// 꺾은선 그래프 렌더링 함수 (Meeting Conversion Rate, Booking Rate용)
function renderChart(canvasId, labels, data, color, label, suffix = '') {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    
    // 기존 차트가 있으면 제거
    if (window[canvasId + 'Chart']) {
        window[canvasId + 'Chart'].destroy();
    }
    
    const chart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: label,
                data: data,
                borderColor: color,
                backgroundColor: color + '20',
                borderWidth: 2,
                fill: true,
                tension: 0.4,
                pointRadius: 4,
                pointBackgroundColor: color,
                pointBorderColor: '#fff',
                pointBorderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    padding: 12,
                    titleFont: { size: 0 },
                    bodyFont: { size: 12 },
                    displayColors: false,
                    callbacks: {
                        title: function() { return ''; },
                        label: function(context) {
                            return context.parsed.y.toLocaleString() + (suffix || '');
                        }
                    },
                    intersect: false,
                    axis: 'x',
                    xAlign: 'center',
                    yAlign: 'bottom',
                    caretSize: 0,
                    caretPadding: 8,
                    cornerRadius: 6,
                    titleSpacing: 0,
                    titleMarginBottom: 0
                },
                datalabels: {
                    anchor: 'end',
                    align: 'top',
                    offset: 2,
                    color: color,
                    font: {
                        size: 10,
                        weight: 'bold'
                    },
                    formatter: function(value) {
                        return value.toLocaleString() + (suffix || '');
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    suggestedMax: (() => {
                        const maxValue = Math.max(...data);
                        // 데이터 레이블이 잘리지 않도록 최대값의 20% 여백 추가
                        return maxValue > 0 ? maxValue * 1.2 : 10;
                    })(),
                    ticks: {
                        font: { size: 10 },
                        callback: function(value) {
                            return value.toLocaleString() + (suffix || '');
                        }
                    },
                    grid: {
                        color: '#f1f5f9'
                    }
                },
                x: {
                    ticks: {
                        font: { size: 10 }
                    },
                    grid: {
                        display: false
                    }
                }
            },
            interaction: {
                mode: 'index',
                intersect: false,
                axis: 'x'
            },
            onHover: (event, activeElements, chart) => {
                if (activeElements && activeElements.length > 0) {
                    canvas.style.cursor = 'pointer';
                } else {
                    canvas.style.cursor = 'default';
                }
            }
        },
        plugins: [ChartDataLabels]
    });
    
    // 툴팁 범위를 2.5배로 확대하기 위한 커스텀 이벤트 핸들러
    canvas.addEventListener('mousemove', function(e) {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const chartArea = chart.chartArea;
        const barWidth = (chartArea.right - chartArea.left) / labels.length;
        const expandedRange = barWidth * 2.5;
        
        let foundIndex = -1;
        labels.forEach((label, index) => {
            const barCenter = chartArea.left + (index + 0.5) * barWidth;
            if (Math.abs(x - barCenter) < expandedRange / 2) {
                foundIndex = index;
            }
        });
        
        if (foundIndex >= 0) {
            const meta = chart.getDatasetMeta(0);
            const point = meta.data[foundIndex];
            if (point) {
                chart.setActiveElements([{
                    datasetIndex: 0,
                    index: foundIndex
                }]);
                chart.update('none');
            }
        } else {
            chart.setActiveElements([]);
            chart.update('none');
        }
    });
    
    window[canvasId + 'Chart'] = chart;
}

// 대시보드 카드 초기화
function initializeDashboardCards() {
    document.getElementById('sum-contact').textContent = '0';
    document.getElementById('sum-meeting').textContent = '0';
    document.getElementById('sum-nego').textContent = '0';
    document.getElementById('sum-won').textContent = '0';
    document.getElementById('sum-budget').textContent = '0';
    document.getElementById('sum-won-budget').textContent = '0';
    document.getElementById('card-contact').textContent = '0';
    document.getElementById('card-meeting').textContent = '0';
    document.getElementById('card-nego').textContent = '0';
    document.getElementById('card-won').textContent = '0';
    document.getElementById('card-won-budget').textContent = '0';
    document.getElementById('card-rate-meeting').textContent = '0%';
    document.getElementById('card-rate-booking').textContent = '0%';
}

// ==========================================
// 날짜 선택 달력 관련 함수들
// ==========================================
let currentDatePickerInput = null;
let currentDatePickerDate = new Date();

// 날짜 선택 달력 열기
function openDatePicker(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    
    currentDatePickerInput = inputId;
    
    // 현재 입력된 날짜 또는 오늘 날짜 사용
    const currentValue = input.value;
    if (currentValue) {
        const dateParts = currentValue.split('-');
        if (dateParts.length === 3) {
            currentDatePickerDate = new Date(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]));
        }
    } else {
        currentDatePickerDate = new Date();
    }
    
    renderDatePicker();
    document.getElementById('datePickerModal').classList.remove('hidden');
}

// 날짜 선택 달력 닫기
function closeDatePicker() {
    document.getElementById('datePickerModal').classList.add('hidden');
    currentDatePickerInput = null;
}

// 날짜 선택 달력 렌더링
function renderDatePicker() {
    const year = currentDatePickerDate.getFullYear();
    const month = currentDatePickerDate.getMonth();
    
    // 월/년도 표시
    const monthNames = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'];
    document.getElementById('datePickerMonthYear').textContent = `${year}년 ${monthNames[month]}`;
    
    // 달력 그리드 생성
    const calendar = document.getElementById('datePickerCalendar');
    calendar.innerHTML = '';
    
    // 요일 헤더
    const weekDays = ['일', '월', '화', '수', '목', '금', '토'];
    weekDays.forEach(day => {
        const dayHeader = document.createElement('div');
        dayHeader.className = 'text-center text-xs font-bold text-gray-500 py-1';
        dayHeader.textContent = day;
        calendar.appendChild(dayHeader);
    });
    
    // 첫 날의 요일 계산
    const firstDay = new Date(year, month, 1);
    const firstDayWeek = firstDay.getDay();
    
    // 마지막 날 계산
    const lastDay = new Date(year, month + 1, 0);
    const lastDate = lastDay.getDate();
    
    // 빈 칸 추가 (첫 날 전)
    for (let i = 0; i < firstDayWeek; i++) {
        const emptyCell = document.createElement('div');
        calendar.appendChild(emptyCell);
    }
    
    // 날짜 셀 추가
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    
    for (let date = 1; date <= lastDate; date++) {
        const dateCell = document.createElement('div');
        dateCell.className = 'text-center text-sm py-1.5 rounded cursor-pointer hover:bg-blue-50 transition';
        
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
        const cellDate = new Date(year, month, date);
        const cellDateStr = cellDate.toISOString().split('T')[0];
        
        if (cellDateStr === todayStr) {
            dateCell.classList.add('bg-blue-100', 'font-bold', 'text-blue-700');
        }
        
        dateCell.textContent = date;
        dateCell.onclick = () => selectDate(dateStr);
        
        calendar.appendChild(dateCell);
    }
}

// 날짜 선택
function selectDate(dateStr) {
    if (!currentDatePickerInput) return;
    
    const input = document.getElementById(currentDatePickerInput);
    if (input) {
        input.value = dateStr;
    }
    
    closeDatePicker();
}

// 오늘 날짜 선택
function selectTodayDate() {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    selectDate(todayStr);
}

// 달력 월 변경
function changeDatePickerMonth(delta) {
    currentDatePickerDate.setMonth(currentDatePickerDate.getMonth() + delta);
    renderDatePicker();
}

// 페이지 로드 시 초기화
document.addEventListener('DOMContentLoaded', () => {
    // Chart.js 플러그인 등록
    if (typeof ChartDataLabels !== 'undefined') {
        Chart.register(ChartDataLabels);
    }
    
    // 날짜 입력 필드 클릭 시 달력 열기
    document.addEventListener('click', (e) => {
        if (e.target.id === 'newPipelineActionDate' || e.target.closest('#newPipelineActionDate')) {
            e.preventDefault();
            openDatePicker('newPipelineActionDate');
        } else if (e.target.id === 'recordActionDate' || e.target.closest('#recordActionDate')) {
            e.preventDefault();
            openDatePicker('recordActionDate');
        } else if (e.target.id === 'editActionDate' || e.target.closest('#editActionDate')) {
            e.preventDefault();
            openDatePicker('editActionDate');
        }
    });
    
    // 기본 섹션 설정
    switchSection('active');
    // Owner 옵션 로드
    loadOwnerOptions();
});
