# Usage Check

Codex · Claude · Gemini/Antigravity · CommandCode · OpenCode 사용량과 남은 한도를 한 화면에서 본다.

이 맥에서만 돈다. 자격증명은 밖으로 나가지 않는다.

## 실행

```bash
npm install
npm run build
./scripts/install-launchd.sh   # 로그인 시 자동 시작 + 죽으면 재시작
```

| 명령 | 하는 일 |
| --- | --- |
| `npm run dev` | 개발 서버 (4300 아님, 4317) |
| `npm run build` | 프로덕션 빌드 |
| `./scripts/install-launchd.sh` | LaunchAgent 설치/재설치 (plist 생성 포함) |
| `npm run snapshot` | 터미널에서 수집 결과만 확인 |

접속: 이 맥은 `http://localhost:4317`, 폰은 Tailscale로 `http://mobb-mbp:4317`.

## 구조

```
lib/collectors/   제공자별 수집기 (프레임워크 비의존 ESM)
lib/snapshot.mjs  수집기 병합 + 라우터 쿼터 결합
app/              Next.js App Router (UI + /api/snapshot)
components/       카드·쿼터바·차트·표·드래그 그리드
scripts/          install-launchd.sh · snapshot.mjs
```

수집기는 전부 `lib/collectors/`에 있고 Next에 묶여 있지 않다. 프레임워크를 갈아엎어도 이 층은 그대로 쓴다.

## 데이터 출처

각 숫자가 어디서 오는지가 이 프로젝트의 핵심이다. 자세한 건 `docs/DECISIONS.md`.

| 제공자 | 출처 |
| --- | --- |
| Codex | `~/.codex/sessions/**/*.jsonl` (head+tail 읽기) |
| Claude | `~/.claude/projects/**/*.jsonl` + `~/.claude.json` 캐시 |
| Gemini/Antigravity | `daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` |
| CommandCode | `api.commandcode.ai/alpha/billing/credits` (codex-router 경유) |
| OpenCode | `~/.local/share/opencode/opencode.db` |
