# Codex / Claude Code 共通の再開手順

この文書は接続方法を定義する基盤コードです。保有・注文・予算・原則・作業進捗の正本は R2 にあります。デプロイ済みかどうか、双方の実接続が確認済みかどうかは、最新の移行記録と実際の読取結果で確認します。このファイルの存在を移行完了の証拠にしません。

| 項目 | 接続先 |
| --- | --- |
| Cloudflare アカウント | 認可済み対象アカウント — `GMS_CF_ACCOUNT_ID` (OAuth から確認した非秘密 ID) |
| 非公開 R2 バケット | `global-macro-strategy-ledger` |
| 正本 prefix | `gms-shared-v1/` |
| 現行版ポインター | `gms-shared-v1/active.json` |
| クライアント | `scripts/shared-r2-client.mjs`、Node.js で実行 |

端末やチャットに親子・マスターの関係はありません。Codex の週間枠に達したら Claude Code、Claude Code の枠に達したら Codex で、以下の同じ手順を使います。枠の検知や別サービスの自動起動はこの仕組みの機能ではありません。利用可能な側で作業を再開し、最後に確定した正本と未完了操作を照合します。

## 接続と最新状態の取得

1. 利用する側で Cloudflare アカウント連携を完了します。別クライアントの OAuth 同意は自動継承されません。パスワード、API トークン、セッション Cookie を会話・Git・R2 の運用記録へ保存しません。
2. Cloudflare MCP の API 検索で R2 object GET/PUT を確認し、`GET /accounts` が上記アカウントを返すことを確認します。読み書きできるという推測と、実際の検証結果を区別します。
3. 新しい GET で active → root → checkpoint → handoff → checkpoint 後の全変更を読みます。各 blob と event のハッシュ、連鎖、件数を検証します。最後に active をもう一度 GET し、最初の root と一致していることを確認します。途中で変わっていたら新しい root からやり直します。
4. checkpoint 後に変更がある場合は、全変更を確認してから判断します。最新の本人指示が古い checkpoint や Git 内の説明に優先します。保存した金融価格を現在値へ昇格させません。
5. handoff と未完了 request を照合し、次の手順を再開します。作業開始時と重要な判断・更新の直前には再取得します。休止中のチャットに自動で記憶が注入されるわけではありません。

Cloudflare MCP `execute` の初回読取例です。ツールの名前はクライアントごとに異なっても、API とバケットは共通です。

```js
async () => cloudflare.request({
  method: 'GET',
  path: '/accounts/' + accountId + '/r2/buckets/global-macro-strategy-ledger/objects/gms-shared-v1/active.json'
})
```

R2 object GET の戻り値は保存された **raw JSON** です。一般の Cloudflare API のように常に `.result` に包まれると仮定しません。blob は `{schema:"gms-blob-v1",encoding:"base64",sha256,bytes,data}` 形式で、SHA-256 は base64 復号後の全バイトに対する値です。

`plan-state-read` は、トークンを渡さず MCP で取得できる次の GET を生成します。

```sh
node scripts/shared-r2-client.mjs connection
node scripts/shared-r2-client.mjs plan-state-read < .sites-runtime/shared-ledger/read-input.json
```

最初の入力は `{"objects":{}}` です。返された `nextReads[].request` を Cloudflare MCP に渡し、結果を `objects[read.key]` に格納して繰り返します。`purpose:"final-active-check"` のときは必ず新しく GET し、結果を `finalActive` に渡します。`stateChanged:true` なら返された新しい active で取得を再開します。`complete:true` の内容に root/checkpoint/handoff/変更列が含まれます。

この読取計画 CLI はネットワークに接続せず、ファイルも書きません。明示的な復元コマンドだけが ignored cache へ書き込みます。入力ファイルだけでは実際の取得時刻を証明できないので、結果の `remoteFreshnessVerified:false` を勝手に true に変えません。接続担当が新しい GET を実行した証拠を持ちます。プログラムから利用する場合は `readCurrentState(getObject)` に実際の認証済み GET 関数を渡すと、前後の active 再取得まで行います。

## 書込・再送・競合

更新の流れは `immutable inbox → R2 通知 → Queue consumer → 検証/CAS → immutable receipt` です。inbox に置けたこと、Queue に通知したこと、処理時間が経過したことは、正本更新の完了ではありません。

1. `prepare-request` で `GET /v1/state` を準備し、返された `upload` をそのまま Cloudflare MCP の `cloudflare.request` に渡します。**最新情報を取得する GET には毎回新しい request ID を使います。** 同じ inbox hash は古い receipt を返すためです。ID を省略すれば CLI が新しい UUID を生成します。`rawBody:true` と `serialized` の全バイトを維持します。JSON を再整形すると inbox キーの SHA と一致しなくなります。
2. `receiptKey` を GET し、`check-receipt` に元の plan と結果を渡して receipt の hash/request ID/status を検証します。成功した state の `result` が ETag を含みます。R2 REST の active GET は ETag ヘッダーを公開しないため、ETag を推測しません。
3. `prepare-append` に `{record,state,requestId,claimedClient}` を渡します。state は検証済みの `/v1/state` receipt の `result` です。クライアントは `if-match` と `expectedLedgerHead` の両方を指定します。`record` は既存台帳と同じ構造で、管理項目 `sequence/hash/previousHash/recordedAt` は追加しません。
4. blob や記録の内容と request ID を保存し、inbox を PUT します。request ID、request hash、ledger event ID は再開時にも同じものを使います。`claimedClient` は説明用ラベルであり、認証済みの個別クライアント識別子ではありません。
5. receipt を検証し、`state:"committed"` と内容一致を確認して初めて記録確定とします。同じ event ID・同じ内容の再送は既存の結果を返し、二重計上しません。同じ event ID の内容を変更して再利用しません。

移行前のイベントは、ID 索引に記録があっても個別 `blobHash:null` の場合があります。一致した既存記録の再送は `existing:true / newlyCommitted:false / archived:true` として扱います。新しく計上したとは認定しません。元イベントの全内容が必要な場合は初期完全 archive から復元し、保存された event hash と照合します。

```sh
node scripts/shared-r2-client.mjs prepare-request < .sites-runtime/shared-ledger/state-request.json
node scripts/shared-r2-client.mjs prepare-append < .sites-runtime/shared-ledger/append-input.json
node scripts/shared-r2-client.mjs check-receipt < .sites-runtime/shared-ledger/receipt-input.json
```

`check-receipt` の入力は `{plan,receipt}`。確認済み 404 の場合にだけ `receipt:null` として pending を扱います。認証失敗・通信失敗・タイムアウトを 404 に置き換えません。409/412 は最新取得と内容の再検討が必要です。新しい ETag だけを付けて古い金融判断を自動再適用しません。

Queue の通知は正本ではなく、保持期限や再試行終了があります。inbox と receipt は R2 に保持されます。未完了操作は同じ inbox 原本と receipt を再確認し、`recovery-message` の `{requestKey,sha256}` を同じ専用 Queue へ再通知できます。再通知前に異なる内容へ変更したり、新しい金融 event ID を作って重複実行したりしません。受信側が CAS 後・receipt 保存前に停止した場合も、既存の event ID と内容で確定済み状態を照合します。

handoff の直前に予告なく停止した場合に備え、R2 inbox 一覧もページ単位で確認します。`reconcileRequests(getObject,inboxKeys)` または `reconcile-captured-requests` は各 canonical request と receipt を照合し、未完了の同じ操作を回復する計画を返します。入力した1ページだけで全件確認済みとは表示しません。一覧の続きを取得し、走査位置を引き継ぎます。GET の未完了と、金融状態を更新し得る POST の未完了を区別します。異なるバイト列で保存された legacy request は再整形せず、元の bytes/hash を回収します。

## 引継ぎ記録

`kind:"task_handoff"` の通常イベントを保存すると root の `latestHandoff` が更新されます。次の項目を `data` に記載します。

- 作業 ID・目的・現在の工程・担当クライアントの説明ラベル。
- 確認した root hash / ledger head、完了した作業と検証証拠の参照。
- 未解決事項、失敗した取得、未検証の前提、変更してはいけない条件。
- 未完了 request の ID/hash/key/receiptKey と既知の状態。receipt 未確認なら pending/unknown のまま。
- `codeRef:{descriptorHash}`。現行 private bootstrap descriptor の参照を次の handoff でも維持する。checkpoint の `data.sharedRuntime.codeRef` にも保管する。
- 次の具体的な手順と、その前提条件。注文・資金移動・決済の実行状態を推測しないこと。

この記録は要点のみです。会話全文や画像を新規保存せず、既存の証拠・数字・時点・制約を引き継ぎます。予期しない週間枠停止に備えて、重要な段階ごとに記録します。停止後に新しい handoff が書けなくても、確定イベントと R2 inbox/receipt に残った操作から回復します。最後の handoff 以後の変更も必ず取得します。

金融判断では最新の保有・注文・予算・原則と既存の品質手順を引き継ぎます。金融の取得担当、取引停止指示、手動実行の境界はクライアント変更によって解除されません。必要な外部接続を Claude/Codex の一方が持たない場合は、その取得を未完了として記録し、無許可の代替価格や推測値で埋めません。

## 生成ファイル・ローカルキャッシュ

`root.artifactManifestHash` はパス付きの生成ファイルを指す Merkle tree、`artifactManifestLedgerHead` はその生成に使用した台帳です。現在の `ledgerHead` と異なる場合、生成された UI や export を最新状態として使いません。正本 checkpoint と変更列が優先し、生成物の更新は別途完了させます。

`readAsset(getObject,treeHash,path)` は tree node、参照 blob、各範囲、最終ファイル全体の SHA を検証します。完全バックアップは初期監査済み archive と以後の不変イベントを含めて復元します。一部の UI ファイルの読取成功を完全復元成功としません。

このクライアントの読み取りには件数・バイト上限があり、超過時は部分的な状態を返さず停止します。上限エラーを無視して判断を続けません。必要な場合は保存済み checkpoint を更新するか、明示的な完全復元手順へ切り替えます。ローカル一時ファイルを使う場合は既存の ignored `.sites-runtime/shared-ledger/` 配下に限定し、必要な今回の入力のみを保持します。認証情報を含めず、Git へ commit しません。CLI はバックグラウンドでの自動保存・自動監視・自動取引を行いません。


## Private 金融実行環境の復元

公開 Git に保有や本人原則はありません。通常の Site artifact にも CLI の scripts は含まれません。金融品質手順は独立した private code bundle として R2 に保管し、最新の `task_handoff.data.codeRef.descriptorHash`、または checkpoint の `data.sharedRuntime.codeRef.descriptorHash` から取得します。参照を会話の記憶や public Git 内の固定値で代替しません。

1. 最新状態を上記の手順で取得・検証し、`code-ref` にその state を渡す。出力の GET 計画で descriptor blob を取得する。descriptor は `gms-private-bootstrap-v1` で、実行コード bundle の SHA・bytes・全ファイル数・entrypoints を含む。
2. descriptor の `codeBundleHash` に対する blob を GET する。`check-code-bundle` に `{descriptorHash,descriptorWrapper,bundleWrapper}` を渡し、wrapper と中身の全 SHA、bytes、パス、entrypoint、manifest を検証する。R2 hash 検証は公開実行許可を意味しない。現行所有者方針に対応するコードであることも確認する。
3. 同じ入力を `restore-code-bundle` に渡す。復元先は現在の checkout の `.sites-runtime/private-runtime/<codeBundleHash>/` に固定される。各ファイルは内容一致なら再利用でき、異なる既存内容や symlink はエラーになる。コードを自動実行しない。descriptor/bundle wrapper も不変 cache に保持し、hydrate 時に最新 codeRef・bundleHash・復元済み全コードの SHA と再照合する。旧 codeRef や改変コードでは停止する。`.code-restore.json` の `financialReady:false` は、まだ金融データを復元していないことを示す。
4. 復元した `AGENTS.md` と `README.md` を読む。runtime 内で `npm test` を実行し、コードの依存関係と合成ケースを確認する。これだけで実際の保有・市場データが現在であるとは認定しない。
5. `plan-finance-data` に `{state,objects,options}` を渡す。`objects` は R2 の key → raw JSON map。必要な `nextReads` を MCP で取得して繰り返す。最新の artifact から context、brief、financeProtocol、data-acquisition-policy を復元する。`options.includeEvents:true` は `finance-context` の stdin JSON `since` や履歴の差分確認、`includeBrokerKnowledge:true` は broker lookup に必要なデータを追加する。金融イベントは checkpoint に反映済みであることが必要で、未反映の金融変更や古い artifact では停止する。
6. `complete:true` の後、active を **改めて GET** する。変わっていたら新状態からやり直す。`hydrate-captured-finance` に `{state,objects,runtimePath,finalActive,options}` を渡し、現在の state と全参照ハッシュを確認した一時 snapshot を runtime 内の `dist/` へ書く。今回 broker knowledge を取得しない場合は前回の broker cache を無効化し、取得方針は常に最新 artifact から復元する。manifest は最後に切り替える。captured input 自体は取得時刻の証明ではなく、出力の `remoteFreshnessVerified:false` を保持する。
7. runtime の `scripts/finance-context.mjs` に今回の金融依頼文または JSON を stdin で渡す。返った原則・ポジション・予算・取得担当・品質手順を読み、最後の checkpoint 以降の handoff と最新本人メッセージを合わせてから分析する。`scripts/finance-calc.mjs` は単位・契約倍率・費用・出典依存を明示した入力の数値検証に使う。

```sh
node scripts/shared-r2-client.mjs code-ref < .sites-runtime/shared-ledger/state.json
node scripts/shared-r2-client.mjs check-code-bundle < .sites-runtime/shared-ledger/code-input.json
node scripts/shared-r2-client.mjs restore-code-bundle < .sites-runtime/shared-ledger/code-input.json
node scripts/shared-r2-client.mjs plan-finance-data < .sites-runtime/shared-ledger/finance-input.json
node scripts/shared-r2-client.mjs hydrate-captured-finance < .sites-runtime/shared-ledger/finance-input.json
```

`readSavedObject` / `read-captured-saved-object` は、現在の manifest にある immutable object ref を検証して追加復元するための補助です。元 JSON が compact artifact にない場合、gzip / gzip-CDC recipe → compressed chunk → decoded chunk → 元 JSON の各 SHA と bytes を確認します。`recall topic/search/event/source` は、その操作が必要とする追加 refs を取得してから実行します。標準 hydrate が全履歴・全 source をローカルへ展開したと扱いません。原文復元は現行の記録方針を確認するまで行いません。

runtime の `dist/records/calculation-cache.json` と `efficiency-observations.json` は再生成可能なローカル計算・読取メモです。これらのファイルだけに重要な結論や未完了操作を置きません。重要な結果・前提・次の手順は R2 の通常イベントへ、書込 pending 原本は inbox へ保存して receipt を確認します。これによりクライアントの利用枠停止でキャッシュが消えても、正本と操作識別子を引き継げます。

コード bundle は1 blob 最大4 MiB、通常の object 読取は32 MiB、各 CLI 入力は64 MiBに制限されます。キャッシュは今回必要な runtime 1版と対象 refs だけを維持します。不要になった旧 runtime は R2 の descriptor/blob/receipt の存在を確認してから ignored cache だけを削除できます。R2 正本・archive はこの清掃の対象ではありません。

同じ code bundle に対して descriptor だけが更新された場合は、旧 cache 内の不変 descriptor と衝突することがあります。新旧 descriptor と bundle が R2 に存在していること、pending 原本が R2 inbox にあることを確認し、対象の ignored runtime cache だけを破棄して新 descriptor から復元します。R2 正本や Git 履歴は削除しません。

## 更新後の生成物同期

private runtime には `scripts/shared-r2-rebuild.mjs` と 現行 R2 からの再生成手順 `docs/shared-r2-rebuild.md` を含めます。公開Gitの新規checkoutから、R2の全artifact/完全exportとその後のcommitted eventを復元し、現行headで生成できます。旧ローカル台帳へのappendは禁止です。新manifestに含まれる全rawファイルの materialize・保存後GET/hash照合・全inventory一致を確認してからartifact CASを実行します。現在のserving上限は各2 MiBです。金融state更新が確定しただけで、UI生成物も最新になったとは扱いません。
