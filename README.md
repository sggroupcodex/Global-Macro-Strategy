# Shared R2 bootstrap

Codex と Claude Code が、同じ非公開 Cloudflare R2 台帳から作業を引き継ぐための基盤コードです。Git にはプログラムと再開手順だけを置きます。このリポジトリには保有状況、金融戦略、本人の原則、証拠、会話履歴、認証情報、実アカウント ID は含みません。

新しい checkout に運用データがないのは正常です。既存の台帳を初期化したり、新しい保存先を自動作成したりしません。

## 初回接続

1. 使用する AI クライアントで Cloudflare OAuth 接続を完了します。もう片方のクライアントの認可は自動継承されません。API トークンやパスワードをチャットへ貼る必要はありません。
2. AI が Cloudflare MCP の API 検索で必要な endpoint を確認し、`GET /accounts` を読みます。ページが複数あれば続きを確認します。
3. 認可済みアカウントの既存 R2 バケットを確認し、対象台帳があるアカウントを確定します。既定のバケット名は `global-macro-strategy-ledger` です。候補が複数ある場合は勝手に選びません。バケット名の一致だけで他人の台帳を扱わないよう、現在の所有者の指示とも照合します。
4. AI が取得した **非秘密の** account ID を、実行プロセスの `GMS_CF_ACCOUNT_ID` に設定します。Git ファイルへ実値を書き込みません。必要に応じて `GMS_R2_BUCKET`、`GMS_R2_PREFIX` も設定します。
5. `node scripts/shared-r2-client.mjs connection` で設定を確認し、[共通再開手順](docs/shared-r2-bootstrap.md)に沿って新しい active/root/checkpoint/handoff と未完了操作を取得します。

環境変数は次の形式です。アカウント ID の実値は Cloudflare 接続から確認し、AI が設定します。

```sh
export GMS_CF_ACCOUNT_ID='<verified-nonsecret-account-id>'
export GMS_R2_BUCKET='global-macro-strategy-ledger'
export GMS_R2_PREFIX='gms-shared-v1/'
```

Cloudflare MCP の `execute` 内では `accountId` または明示的な account ID を使います。CLI 自体にはトークン・ネットワーク通信を持たせていません。明示的な復元コマンドだけが ignored cache へ書き込みます。MCP に渡す GET/PUT 計画を生成し、戻り値をローカルで検証します。既存のプロキシやネットワーク制限を迂回しません。

## 再開に必要な確認

- active の前後一致と blob/event のハッシュ・連鎖・件数を確認する。
- 最新 checkpoint の後の変更も読み、古い checkpoint や古いチャット記憶だけで判断しない。
- handoff の作業内容、完了した検証、未解決事項、次の手順を読む。
- inbox をページ単位で走査し、handoff に書けなかった未完了操作も receipt と照合する。
- 409/412 は最新状態の読取と再判断が必要。古い操作を新しい ETag だけで自動再適用しない。
- fresh GET は新しい request ID を使い、書込 retry は同じ ID・同じ bytes を使う。
- 元の金融記録が archive 内にある legacy ID の再送は、既存記録の確認として扱い、新規計上しない。

非公開の分析手順・品質検証コードは、最新 handoff の `data.codeRef.descriptorHash` または checkpoint の `data.sharedRuntime.codeRef.descriptorHash` から取得します。`code-ref` → descriptor/blob GET → `check-code-bundle` → `restore-code-bundle` で検証し、`.sites-runtime/private-runtime/<codeBundleHash>/` へ復元します。コード復元時点では金融データが入っていません。

続いて `plan-finance-data` が示す必要 blob を MCP で取得し、改めて active を GET して同じ版を確認します。`hydrate-captured-finance` で最新 checkpoint と一致する context/brief/protocol/取得方針を runtime へ復元し、その `AGENTS.md` と `docs/finance-quality.md` を読んで `scripts/finance-context.mjs` を依頼ごとに実行します。古い artifact、未反映の金融変更、参照・依存物の不足はエラーになります。詳細と JSON 入力形式は [共通再開手順](docs/shared-r2-bootstrap.md) にあります。

取得したデータ・pending plan・結果・private コードは、ignored `.sites-runtime/` 配下の必要最小限の一時キャッシュに置きます。新規に蓄積する運用記録は R2 へ保存し、Git に commit しません。プログラムは保存用の巨大アーカイブを自動で読み込まず、通常読取には明示的な上限を設けています。上限に達した場合、部分的な結果を完全な状態として返しません。

週間利用枠に達した場合は、使用できる側のクライアントでこの手順を実行します。特定の端末・チャットがマスターになることはありません。別サービスを自動起動したり、休止中のチャットへ自動で記憶を注入したりする機能ではありません。

移行の追加監査証拠は、認可済み R2 の設定済み prefix にある `migration-completion.json` から確認します。これは補助的な証拠索引で、`active.json` や台帳の正本を置き換えません。索引が示す検証対象時点と manifest の key/SHA を確認し、取得した証拠の全 SHA を照合します。履歴時点の監査を現在の状態へ読み替えず、未存在・未確認・返信待ちは完了と推定しません。公開 Git には索引の実データや監査対象の情報を保存しません。

## 検証

Node.js 22 以降で、追加依存パッケージなしに実行できます。

```sh
npm test
```

テストは合成アカウントとローカル fixture のみを使用し、Cloudflare や証券口座へ接続しません。実際の正本への読み書き・両クライアントの連携・完全復元は、別の実環境検証が必要です。
