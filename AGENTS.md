# Shared R2 continuity bootstrap

この checkout は共通クライアントと再開手順だけを含む公開の基盤です。運用データの正本ではありません。未取得の保有、注文、予算、原則、未完了作業を推測しないでください。

1. `README.md` と `docs/shared-r2-bootstrap.md` を読み、現在のクライアントの Cloudflare OAuth 接続を確認する。アカウントと既存バケットを API で照合し、非秘密の account ID を `GMS_CF_ACCOUNT_ID` へ設定する。認証情報を要求・表示・Git 保存しない。
2. 毎回の作業開始と重要な判断・書込前に、R2 active/root/checkpoint/handoff と checkpoint 後の全変更を取得する。クライアントの hash/連鎖検証と前後の active 確認を実施する。古いチャットやキャッシュだけで現状を認定しない。
3. active が見つからない場合は接続先・移行状態を確認する。空の台帳を新規初期化したり、過去の状態で上書きしたりしない。認証・通信失敗を「記録なし」に置き換えない。
4. handoff に列挙された pending request と R2 inbox 一覧を receipt に照合する。通知送信・待機時間・準備ファイルの存在は完了証拠ではない。同じ書込の再送は同じ ID/内容、最新 GET は新しい ID。競合は再読込と再判断へ戻す。
5. 最新の所有者指示、金融原則、取引停止、予算、実行権限、データ取得担当を R2 の現行記録から復元する。公開コード中の例やテストを本人の情報として扱わない。別 AI へ移ったことを根拠に制約を解除しない。
6. 金融分析に必要な private 品質手順・検証コードを、現行 handoff の data.codeRef または checkpoint の data.sharedRuntime.codeRef から取得する。code-ref/check-code-bundle/restore-code-bundle で検証・復元し、その AGENTS.md を読む。plan-finance-data と新しい active GET、hydrate-captured-finance で最新状態を復元してから、runtime の scripts/finance-context.mjs を金融依頼ごとに実行する。参照・依存物が不足、artifact が古い、未反映の金融変更がある場合は整合を先に完了する。この kit の単体テスト合格だけで金融分析の準備完了としない。
7. 重要な作業段階ごとに、要点・証拠・検証結果・未解決事項・未receipt操作・次の具体手順を R2 の `task_handoff` イベントへ記録する。codeRef も次の handoff へ維持する。全文会話や画像の自動保存は行わず、最新の所有者の記録方針に従う。
8. `.sites-runtime/` は ignored の一時キャッシュとして使う。データ、原則、保有、証拠、pending plan、結果、バックアップ、private コード、トークンをこの公開リポジトリへ追加しない。正本・復元用 archive の削除や Git 履歴の書換えを自動実施しない。

すべてのコマンドは既存のプロキシ・認証・ネットワーク制限を維持します。Cloudflare の保存権限は金融取引の実行権限ではありません。利用枠の切替や再開そのものは注文・取消・決済・資金移動を意味しません。
