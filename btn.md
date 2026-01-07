# 아코디언 표 Stage 칼럼 스타일 설명

## 개요
아코디언 표의 Stage 칼럼에서 배경색이 칠해진 박스의 너비가 텍스트보다 넓고, 수정 펜이 그 박스 안으로 들어간 디자인 구조에 대한 설명입니다.

## 구조 분석

### 1. 셀 구조
```javascript
stageCell.style.position = 'relative';  // 펜 버튼의 absolute 위치 기준점
stageCell.style.textAlign = 'center';   // 셀 전체 중앙 정렬
```

### 2. 배경색 박스 (Stage 텍스트)
```javascript
<span class="${stageClass} text-xs font-medium" 
      style="display: inline-block; width: 100%; text-align: center;">
  ${stageText}
</span>
```

**주요 스타일 속성:**
- `display: inline-block`: 블록처럼 너비/높이 설정 가능하면서도 인라인처럼 동작
- `width: 100%`: 셀 전체 너비를 차지하도록 설정
- `text-align: center`: 텍스트를 박스 내부에서 중앙 정렬
- `stageClass`: 배경색 클래스 (`bg-green-100`, `bg-yellow-100` 등)
- `px-2 py-0.5 rounded`: 패딩과 둥근 모서리 적용

### 3. 수정 펜 버튼
```javascript
<span class="btn-edit ..." 
      style="position: absolute; right: 0.5rem; top: 50%; transform: translateY(-50%);">
  edit
</span>
```

**주요 스타일 속성:**
- `position: absolute`: 부모 요소(`position: relative`)를 기준으로 절대 위치 지정
- `right: 0.5rem`: 우측에서 0.5rem 떨어진 위치에 배치
- `top: 50%; transform: translateY(-50%)`: 수직 중앙 정렬을 위한 트릭

## 결과

이 구조로 인해:
- ✅ 배경색 박스가 셀 전체 너비(`width: 100%`)를 차지
- ✅ 텍스트는 박스 내부에서 중앙 정렬
- ✅ 펜 버튼은 박스 위에 오버레이되어 우측에 배치

**시각적 효과:**
배경색 박스가 텍스트보다 넓게 표시되고, 펜 버튼이 박스 영역 안에 보이게 됩니다.
