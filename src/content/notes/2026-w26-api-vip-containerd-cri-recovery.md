---
title: GPUノード追加の前に、Kubernetes APIとcontainerd CRIを復旧した
date: 2026-06-29
tags:
  - kubernetes
  - kubeadm
  - containerd
  - kube-vip
  - sre
  - incident
  - homelab
---

使っていなかったGALLERIAのデスクトップPCを、RTX 4070搭載のGPUノードとしてKubernetesに追加しようとしました。これまではクラスタとは切り離して使っていましたが、今後のRCA研究でLocal LLMを試したいこと、また機械学習を触っている知人にも実験環境として使ってもらう可能性が出てきたことから、Kueueなども見据えてKubernetes側へ寄せることにしました。

ところが、実際に進めてみると、最初に詰まったのはGPUでもNVIDIA driverでもありませんでした。`kubeadm join` の前にAPI endpointへ疎通確認をしたところ、Kubernetes APIのVIPに到達できませんでした。GPUノード追加の作業はそこで止まり、まず既存control-planeの復旧作業に切り替わりました。

## 3行まとめ

- GPUノードをjoinする前に、Kubernetes API VIPがどのノードにも載っていないことに気づきました。
- 一時的に既存のcontrol-planeへVIPを載せても、`readyz` では `etcd failed` が出ており、根本原因はさらに下にありました。
- 最終的には、containerd 2.2.1 のCRI設定不整合を修正し、kubeletがstatic Podを再び管理できる状態に戻しました。

## 前提と非スコープ

今回の対象は、kubeadmで構成しているhomelab Kubernetesクラスタです。ノード名には過去の構築経緯が残っており、`worker1` や `worker2` という名前のノードも実際にはcontrol-plane roleを持っています。本文では読者が混乱しないように、必要に応じて「control-plane兼worker」と表記します。

今回扱うものは以下です。

- Kubernetes API VIPへの疎通
- kube-vipのVIP保持
- kube-apiserverの`livez` / `readyz`
- etcd health
- kubeletとcontainerd CRIの関係
- containerd 2.2.1の設定不整合

逆に、今回は以下までは扱いません。

- GPUノードの最終join
- NVIDIA Device Plugin
- Longhorn disk追加
- Misskeyのアプリケーション側の問題
- `kubeadm reset` やetcd member削除

実IPは記事の理解に必要な範囲だけに抑えます。以下ではAPIの入口を `<API-VIP>`、既存control-planeを `control-plane-1/2/3` のように書きます。

## 最初に見えた症状

GPUノード側に、既存Kubernetes用の補助IPを追加したあと、まずAPI VIPへの疎通を確認しました。

```bash
API_VIP=<API-VIP>
ping -c 2 "$API_VIP"
timeout 5 bash -c "</dev/tcp/$API_VIP/6443"
```

結果は `Destination Host Unreachable` と `No route to host` でした。

最初はGPUノード側のネットワーク設定を疑いました。新規に追加したノードなので、経路やIPの付け方を間違えている可能性は十分あります。ただ、同じGPUノードから既存control-planeや既存workerの補助IPには到達できていました。

```text
既存control-planeの補助IP: OK
既存workerの補助IP:        OK
API VIP:                    NG
```

この時点で、補助IPを使っているL2セグメント自体は通っているが、VIPだけが存在していない可能性が高いと考えました。

![API経路と失敗箇所](/images/2026-w26-api-cri-recovery/api-path-and-failure.svg)

## master側でもVIPに届かなかった

次に、既存のmaster側からも同じAPI VIPを確認しました。kubeconfigはもともとそのVIPを向いています。

```bash
kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}{"\n"}'
kubectl get nodes -o wide
```

結果として、`kubectl` もAPIに到達できませんでした。

```text
Unable to connect to the server: dial tcp <API-VIP>:6443: connect: no route to host
```

この時点で、GPUノード側の問題ではなく、既存クラスタ側のAPI入口が壊れていると見ました。

control-plane個別のAPI endpointを確認すると、少なくとも1台のcontrol-planeではapiserverがLISTENしていました。そこで、いったんそのノードをAPI入口として使えるか確認することにしました。

## 一時的にVIPを載せる

apiserverがLISTENしていたcontrol-planeに、一時的にAPI VIPを載せました。

```bash
sudo ip addr add <API-VIP>/32 dev <interface>
```

このあと、VIPへのpingとTCP 6443は戻りました。

```text
ping <API-VIP>      OK
TCP <API-VIP>:6443  OK
```

ここで一瞬「これで戻ったか」と思いました。ですが、`kubectl get nodes` はまだ安定して返りませんでした。

そこで、直接 `readyz` を見ました。

```bash
curl -k --max-time 20 "https://<API-VIP>:6443/readyz?verbose"
```

重要だったのは、この部分です。

```text
[-]etcd failed
[-]etcd-readiness failed
readyz check failed
```

つまり、VIPの疎通だけは戻ったものの、API serverとしては正常ではありませんでした。ここで、問題はkube-vip単体ではなく、apiserverからetcdへ降りた先か、あるいはstatic Podを管理しているkubelet / containerd側にあると考えました。

## etcdを直接いじらなかった理由

`readyz` に `etcd failed` と出ると、すぐetcdを疑いたくなります。実際、自分も最初は「etcdのquorumが壊れているのでは」と考えました。

ただ、ここでいきなり `etcd member remove` やdata dirの削除に進むのは危険です。etcdが本当に壊れているのか、それともetcdのstatic Podを管理しているkubelet側が壊れているのかを分ける必要があります。

そこで、control-planeノード上でcontainer runtime側を確認しました。

```bash
sudo crictl --runtime-endpoint unix:///run/containerd/containerd.sock info
```

返ってきたのは、以下のようなエラーでした。

```text
unknown service runtime.v1.RuntimeService
```

kubeletのログにも似た症状がありました。

```text
Failed to list pod sandboxes
GenericPLEG: Unable to retrieve pods
validate CRI v1 runtime API failed
```

containerd自体は起動しているのに、kubeletが期待するCRI serviceが見えていない状態です。ここで、`etcd failed` は結果として見えているだけで、原因はさらに下のcontainerd CRIにある可能性が高くなりました。

## containerd 2.2.1の設定不整合

containerdのログを追うと、原因らしい行が見つかりました。

```text
mirrors cannot be set when config_path is provided
```

設定には、古い `registry.mirrors` と、新しい `config_path` が混在していました。ざっくり書くと、こういう状態です。

```text
/etc/containerd/config.toml
  registry.mirrors.<private registry> が残っている
  config_path も使っている
```

この組み合わせにより、CRI image service pluginがロードできず、結果としてkubeletがcontainerdのCRIに接続できなくなっていました。

ここでようやく、復旧の対象が見えました。etcdを直接いじるのではなく、containerdのCRI設定を戻します。

## 修正方針

まず、設定ファイルをバックアップしました。

```bash
sudo cp -a /etc/containerd/config.toml /etc/containerd/config.toml.bak-$(date +%Y%m%d-%H%M%S)
```

その後、古い `registry.mirrors` セクションを削除し、private registry向けの設定は `certs.d` 方式に寄せました。

```toml
# /etc/containerd/certs.d/<registry-name>/hosts.toml
server = "http://<registry-name>"

[host."http://<registry-name>"]
  capabilities = ["pull", "resolve", "push"]
  skip_verify = true
```

その後、control-planeを同時に触らないように、ノードごとに順番に再起動しました。

```bash
sudo systemctl restart containerd
sleep 10
sudo systemctl restart kubelet
```

ここはかなり慎重に進めました。control-planeのruntimeを触っているので、全台同時に再起動すると、失敗したときに戻りづらくなります。

![CRI復旧の順序](/images/2026-w26-api-cri-recovery/スクリーンショット%202026-06-29%20155048.png)

## 復旧確認

各ノードで、CRI pluginが戻ったか確認しました。

```bash
sudo ctr plugins ls | egrep "TYPE|cri|runtime"
sudo crictl --runtime-endpoint unix:///run/containerd/containerd.sock info
```

期待する状態は以下です。

```text
io.containerd.cri.v1 images    ok
io.containerd.cri.v1 runtime   ok
io.containerd.grpc.v1 cri      ok
crictl info OK
```

これが戻ると、kubeletがstatic Podを再び管理できるようになりました。その後、APIのhealthも戻りました。

```text
livez check passed
readyz check passed
kubectl get nodes OK
```

## 手動VIPを外す

復旧途中で一時的に載せていたVIPは、最終的に外しました。

この時点では、kube-vipのLease holderはmaster側になっており、VIPもそちらに載っていました。一時的に載せたVIPは残骸になっていたため削除しました。

```bash
sudo ip addr del <API-VIP>/32 dev <interface>
```

削除後も、以下は維持されました。

```text
ping <API-VIP> OK
TCP <API-VIP>:6443 OK
kubectl get nodes OK
```

ここでようやく、GPUノードjoin作業へ戻れる状態になりました。

## 今回やらなかったこと

今回、以下はやりませんでした。

```text
- kubeadm reset
- etcd member remove
- etcd data dir削除
- kube-vip manifestの即時変更
- GPUノードjoinの強行
```

結果として、これはよい判断だったと思います。`readyz` ではetcd failedに見えていましたが、直接の修正対象はcontainerd CRIでした。

## 学び

GPUノード追加は、GPUだけの作業ではありませんでした。新しいノードをjoinするには、既存APIが安定している必要があります。今回の環境では、`kubeadm join` の前にAPI VIP、kube-apiserver、etcd、kubelet、containerd CRIの前提が崩れていました。

次から新しいノードを追加する前には、最低限これを見ます。

```bash
kubectl get nodes -o wide
curl -k "https://<API-VIP>:6443/readyz?verbose"
sudo crictl --runtime-endpoint unix:///run/containerd/containerd.sock info
```

地味ですが、これを飛ばすと、ノード追加作業が既存基盤の障害対応にすり替わります。今回まさにそうなりました。
