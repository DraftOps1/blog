---
title: Longhornのdegraded volumeを戻すために、control-plane兼workerへ2TB SSDを追加した
date: 2026-06-29
tags:
  - kubernetes
  - longhorn
  - storage
  - sre
  - homelab
---

GPUノードを追加する前にLonghornの状態を見たところ、一部のvolumeが `degraded` のまま残っていました。以前このクラスタでは、root filesystemの圧迫からEvicted Podが大量に出たこともあり、storageまわりは一度ちゃんと整理しておく必要があると感じていました。

今回やったのは、既存ノードに2TB SSDを追加して、Longhornの追加diskとして登録することです。単に容量が足りないからSSDを足した、というより、root diskへの依存を減らし、Longhornのreplica配置先に余裕を作るための変更でした。

## 3行まとめ

- 以前のephemeral-storage問題は、root filesystem圧迫がPod evictionにつながるという学びでした。
- 今回の2TB SSD追加は、その直接修正というより、Longhorn replica配置とcapacityに余裕を作るための変更でした。
- SSD追加前にリンク速度を確認したところ一時100Mb/sだったため、まず1Gbpsへ戻してから作業しました。

## 前提と非スコープ

対象ノードの実ホスト名は `k8s-worker2` ですが、実際にはcontrol-plane roleを持っています。過去の構築経緯で名前と役割がずれているため、本文では「control-plane兼worker」と呼びます。

今回扱うものは以下です。

- 新規2TB SSDのOS側認識
- ext4での初期化
- `/mnt/longhorn-2tb` へのmount
- Longhorn disk追加
- degraded volumeの回復
- root filesystem圧迫リスクの低減

今回扱わないものは以下です。

- 既存volumeの手動移行
- PVC削除
- Longhorn再構築
- NAS / NFS移行
- GPUノードをstorageに使うこと

## ephemeral-storage問題との関係

以前、このクラスタではroot filesystemが詰まり、Evicted Podが大量に出たことがありました。そのときに分かったのは、Kubernetesの障害はアプリケーションだけではなく、node filesystemやcontainer image、Longhorn replicaのような基盤側の容量問題として出ることがある、ということです。

今回の2TB SSD追加は、ephemeral-storage evictionを直接直す作業ではありません。ephemeral-storage evictionそのものは、nodeのroot filesystemやcontainer runtimeの使用量が直接関係します。

ただし、Longhornのvolumeデータやreplicaをroot diskだけに寄せ続ける構成は、長期的には同じ種類のstorage pressureを生みやすいです。今回のSSD追加は、その反省を踏まえ、Longhornの保存先に余裕を作るための変更でした。

## 選択肢を整理する

最初は、いくつか選択肢がありました。

![storage decision matrix](/images/2026-w26-longhorn-2tb/storage-decision-matrix.svg)

表として書くと、以下のような判断です。

| 選択肢 | 容量改善 | root圧迫回避 | 作業リスク | 即効性 | 今後の拡張性 | コメント |
|---|---:|---:|---:|---:|---:|---|
| 何もしない | 1 | 1 | 5 | 5 | 1 | degraded解消にはならない |
| root LVを拡張する | 2 | 2 | 3 | 3 | 2 | root disk依存は残る |
| 2TB SSDを追加する | 5 | 4 | 3 | 4 | 4 | 今回選択 |
| GPUノードもstorageに使う | 3 | 3 | 2 | 3 | 2 | compute専用方針と衝突 |
| NAS/NFSへ逃がす | 4 | 5 | 2 | 2 | 4 | 別の可用性設計が必要 |

この表は厳密なベンチマークではありません。あくまで今回のhomelabでの意思決定メモです。ただ、「なぜこの変更を選んだのか」をあとから説明するには役に立ちます。

## まずネットワーク速度を見た

SSDを追加する前に、対象ノードのリンク速度を確認しました。

```bash
sudo ethtool <default-interface>
```

最初はこうでした。

```text
Speed: 100Mb/s
Duplex: Full
Link detected: yes
```

これはLonghorn用途としては弱いです。replica rebuildやvolume attachではネットワークを使うため、ここが100Mb/sのままでは、容量を増やしても別のボトルネックになります。

ケーブルとポートを見直した後、再確認すると1Gbpsに戻りました。

```text
Speed: 1000Mb/s
Duplex: Full
Link detected: yes
```

ここを先に見ておいてよかったです。もし100Mb/sのままdiskを追加していたら、あとから「容量は増えたのにrebuildが遅い」という別の問題として見えていたと思います。

## SSDを確認する

対象ノードで `lsblk` を確認しました。

```text
root disk:  約240G
new disk:   1.8T  Extreme 55AE  usb
partition:  exfat
```

新しいSSDはUSB接続の外付けSSDとして見えていました。最初はexfatだったため、Longhorn用にext4で作り直すことにしました。

ここで一番怖いのは、root diskと間違えることです。実際の作業では、`lsblk`、`blkid`、`udevadm info` を見て、対象diskが新しい2TB SSDであることを確認してから進めました。

## ext4で作り直してmountする

作業は以下の流れでした。

```bash
sudo wipefs -a /dev/<new-disk>
sudo parted -s /dev/<new-disk> mklabel gpt
sudo parted -s -a optimal /dev/<new-disk> mkpart primary ext4 0% 100%
sudo mkfs.ext4 -F -L LONGHORN2TB /dev/<new-partition>
sudo tune2fs -m 0 /dev/<new-partition>
```

mount先は以下にしました。

```text
/mnt/longhorn-2tb
```

`/etc/fstab` にはUUIDで登録しました。

```text
UUID=<uuid> /mnt/longhorn-2tb ext4 defaults,noatime,nofail 0 2
```

確認結果は以下です。

```text
/dev/<new-partition>  1.8T  ext4  /mnt/longhorn-2tb
```

write testも通りました。ここまででOS側の準備は完了です。

## Longhornへ登録する

Longhorn UIから、対象ノードへdiskを追加しました。

![Longhorn nodes before disk add](/images/2026-w26-longhorn-2tb/01-longhorn-nodes.png)

入力した内容は以下です。

```text
Name:
  worker2-ssd-2tb

Path:
  /mnt/longhorn-2tb

Allow Scheduling:
  Enabled

Storage Reserved:
  200GiB
```

![Longhorn add disk](/images/2026-w26-longhorn-2tb/02-longhorn-add-disk.png)

ここで少し迷ったのは、USB接続のSSDをLonghornに使ってよいかです。今回の判断はこうです。

```text
使う:
  PoC / homelab / 追加replica先として使う

注意:
  重要データの唯一の保存先にはしない
  USB抜け・省電力・発熱・接触不良に注意する
  replicaは複数ノードに分散する
```

本番相当の堅牢なstorageとして扱うには弱いですが、今回のhomelabでは、Longhornの容量とreplica配置に余裕を作る目的としては十分と判断しました。

## degraded volumeが戻る

SSD登録後、Longhornが新しいdisk上にreplicaをスケジュールし始めました。当初degradedだったvolumeには、Grafana、Harbor registry、Alertmanager、Harbor Trivyなどが含まれていました。

しばらく待つと、`degraded` / `faulted` / `rebuilding` は表示されなくなりました。

```bash
kubectl -n longhorn-system get volumes.longhorn.io \
  -o custom-columns=NAME:.metadata.name,STATE:.status.state,ROBUSTNESS:.status.robustness
```

この時点で、稼働中volumeのrobustnessは戻ったと判断しました。停止中workloadに紐づく `detached unknown` は残りますが、今回の運用上は異常として扱いません。

![Longhorn before and after](/images/2026-w26-longhorn-2tb/longhorn-before-after.svg)

## GPUノードをstorageに使わなかった理由

同じタイミングでGPUノードも追加していたため、そのroot diskをLonghornに使う選択肢もありました。ただ、今回はやめました。

理由は、GPUノードはcompute専用にしたかったからです。NVIDIA driverやCUDA runtimeの更新で再起動する可能性がありますし、今後Local LLMなどのGPU workloadを載せる予定もあります。そこにstorage replicaを同居させると、障害時の責任境界が曖昧になります。

最終的に、GPUノード側はLonghornのschedulingを無効化しました。

```text
GPU node:
  allowScheduling: false
```

## 今回の学び

今回の変更は、単なるSSD追加ではありませんでした。

実際の順番として重要だったのは以下です。

```text
1. Longhorn degradedを確認する
2. 追加先ノードのリンク速度を見る
3. 100Mb/sなら先に直す
4. 新しいdiskをOS側で安全にmountする
5. Longhornにdisk追加する
6. degradedが戻るか見る
```

容量を増やすだけなら簡単です。ただ、Kubernetes storageとして使うなら、ネットワーク速度、mount永続化、replica配置、USB接続の信頼性まで含めて見る必要がありました。

まだ完璧なstorage構成ではありませんが、少なくともGPUノード追加や次のRCA実験へ進む前のstorage不安は減らせたと思います。
