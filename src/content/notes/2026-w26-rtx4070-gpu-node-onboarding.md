---
title: RTX 4070をKubernetesのGPUノードとして追加した
date: 2026-06-29
tags:
  - kubernetes
  - gpu
  - nvidia
  - containerd
  - kubeadm
  - homelab
---

使っていなかったGALLERIAのデスクトップPCにRTX 4070を載せ、KubernetesのGPUノードとして追加しました。最初は「Ubuntuを入れて、NVIDIA driverを入れて、kubeadm joinすれば終わり」くらいに考えていましたが、実際にはそうなりませんでした。API VIPが壊れていたり、containerd CRIが壊れていたり、Device PluginがCrashLoopBackOffしたりして、GPUそのものよりPlatform側の前提を確認する時間の方が長かったです。

この記事では、RTX 4070をKubernetes上で `nvidia.com/gpu=1` として認識させ、Pod内から `nvidia-smi` を実行できるまでの流れを書きます。きれいな手順書というより、今回の環境でどこを確認し、どこで詰まり、どう判断したかの記録です。

## 3行まとめ

- RTX 4070を載せたPCにUbuntu Serverを入れ、`k8s-gpu1` としてKubernetesにjoinしました。
- NVIDIA driver、NVIDIA Container Toolkit、RuntimeClass、NVIDIA Device Pluginを順番に確認しました。
- 最終的に `nvidia.com/gpu=1` が見え、GPU Pod内で `nvidia-smi` が成功しました。

## 前提と非スコープ

今回追加したノードは以下です。

```text
hostname:
  k8s-gpu1

GPU:
  NVIDIA GeForce RTX 4070

OS:
  Ubuntu 24.04.4 LTS

Kubernetes:
  v1.31.14

Container runtime:
  containerd 2.2.1
```

今回扱うものは以下です。

- Ubuntu Server install
- NVIDIA driver
- NVIDIA Container Toolkit
- kubeadm join
- node label / taint
- RuntimeClass
- NVIDIA Device Plugin
- GPU Pod test

今回扱わないものは以下です。

- LLM workload
- DCGM exporter
- GPU monitoring
- GPU benchmark
- inference performance
- multi-GPU scheduling

## いきなりjoinしなかった理由

GPUノードを追加するとき、最初からKubernetesにjoinすると、問題が起きたときに切り分けづらくなります。少なくとも今回は、以下の順番で確認しました。

![GPU stack](/images/2026-w26-gpu-node/スクリーンショット%202026-06-29%20151906.png)

この順番にした理由は、どこで失敗しているかを分けるためです。

PodでGPUが見えない場合でも、原因は複数あります。

```text
- そもそもPCIeでGPUが見えていない
- NVIDIA driverが入っていない
- nvidia-smiがホストで動かない
- container runtimeにnvidia runtimeが入っていない
- RuntimeClassがない
- Device Pluginが落ちている
- PodがGPU resourceをrequestしていない
```

今回も、実際にDevice Pluginで一度詰まりました。

## Ubuntu Serverを入れる

もともとこのPCにはWindowsが入っていましたが、GPUノード専用にするため削除しました。Ubuntu Serverのインストール時、storage画面でroot `/` が100GB程度になりそうでした。

ここで一度止めました。

過去にこのクラスタでは、root filesystemが詰まってPod evictionが起きたことがあります。GPUノードではcontainer imageやCUDA image、将来のLLM imageが増える可能性があります。rootを100GBのままにするのは避けたいと考えました。

最終的には、LVMのroot LVを400GBにしました。

```text
/boot/efi: 1G
/boot:     2G
/:         400G
```

インストール後の確認では、`/` は約393GBとして見えました。

```text
/dev/mapper/ubuntu--vg-ubuntu--lv  393G
```

これは地味ですが、あとで効く判断だと思います。

## RTX 4070をOSから確認する

Ubuntu起動後、まず `lspci` でGPUを確認しました。

```text
NVIDIA Corporation AD104 [GeForce RTX 4070]
```

最初は `nouveau` driverでした。その後、NVIDIA driverを入れて再起動し、`nvidia-smi` を確認しました。

```text
NVIDIA-SMI 595.71.05
Driver Version: 595.71.05
CUDA Version: 13.2
GPU: NVIDIA GeForce RTX 4070
Memory: 12282MiB
Temp: 40〜42C
Power: 13W / 200W
```

![host nvidia-smi](/images/2026-w26-gpu-node/01-gpu-nvidia-smi.png)

ホスト上で `nvidia-smi` が通ったので、少なくともGPUとdriverは正常に見えていると判断しました。

## NVIDIA Container Toolkit

次に、containerdからGPUを使うためにNVIDIA Container Toolkitを確認しました。

```text
NVIDIA Container Toolkit CLI version 1.19.1
NVRM version: 595.71.05
CUDA version: 13.2
Model: NVIDIA GeForce RTX 4070
```

containerd側には、以下のruntimeが入っていました。

```text
runtimes.nvidia:
  runtime_type = io.containerd.runc.v2
  BinaryName = /usr/bin/nvidia-container-runtime
```

ここまでで、ホストGPUとcontainer runtimeの前提は揃いました。

## kubeadm join前にAPIが壊れていた

ここでKubernetesへjoinする予定でしたが、その前にAPI VIPを確認しました。

```bash
ping <API-VIP>
timeout 5 bash -c '</dev/tcp/<API-VIP>/6443'
```

最初はここで失敗しました。GPUノード側の問題かと思いましたが、既存のmasterからもVIPに届いていませんでした。

つまり、GPUノード追加の前に、既存クラスタのAPI / kube-vip / containerd CRIを直す必要がありました。ここは別記事に分けますが、今回のGPU追加で一番大きかった詰まりは、実はGPUではなく既存Platform側でした。

## kubeadm join

APIが復旧したあと、GPUノードでjoinしました。ただし、一度preflightで失敗しました。

```text
[ERROR FileExisting-conntrack]: conntrack not found in system path
```

対応は単純で、`conntrack` を入れました。

```bash
sudo apt-get install -y conntrack
```

最終的にjoinは成功しました。

```text
This node has joined the cluster
```

master側では以下になりました。

```text
k8s-gpu1 Ready
VERSION v1.31.14
INTERNAL-IP GPU node address
containerd://2.2.1
```

## GPUノードとしてlabel / taintを付ける

GPUノードには通常workloadを載せたくないため、labelとtaintを付けました。

```text
Labels:
  node-role.kubernetes.io/gpu=
  homelab.local/gpu=true
  homelab.local/gpu-model=rtx4070
  nvidia.com/gpu.present=true

Taints:
  nvidia.com/gpu=true:NoSchedule
```

最初、古いプロジェクト名を含むlabelを使いそうになりましたが、今はその名前を使っていないので、`homelab.local/gpu` に寄せました。ラベルは後からmanifestやrunbookに残るため、ここで古い名前を入れると後で混乱します。

## Longhornの保存先にはしない

join直後、GPUノードにもLonghornのDaemonSetが乗りました。これは正常です。

ただし、GPUノードのroot diskをLonghorn replica保存先にはしたくありませんでした。GPUノードは今後driver更新やCUDA runtime更新で再起動する可能性が高いですし、GPU workload用に使いたいからです。

そのため、Longhornのschedulingを無効化しました。

```text
GPU node:
  allowScheduling: false
```

DaemonSetとしてLonghornのPodがいることは許容しつつ、保存先としては使わない方針です。

## NVIDIA Device Pluginが最初CrashLoopBackOffした

NVIDIA Device Pluginを最初に入れたとき、PodはCrashLoopBackOffになりました。

```text
nvidia-device-plugin 0/1 CrashLoopBackOff
GPU allocatable <none>
```

ホスト上では `nvidia-smi` が動きます。`/dev/nvidia*` もあります。`nvidia-container-cli info` も通ります。

このため、問題はホストdriverではなく、Kubernetes上のDevice Plugin PodがNVIDIA runtimeで起動していないことだと考えました。

## RuntimeClass nvidiaを使う

`RuntimeClass` を作りました。

```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: nvidia
handler: nvidia
```

そのうえで、Device PluginのDaemonSetに `runtimeClassName: nvidia` を追加しました。

```yaml
spec:
  template:
    spec:
      runtimeClassName: nvidia
      nodeSelector:
        homelab.local/gpu: "true"
```

これでDevice PluginはRunningになりました。

```text
nvidia-device-plugin-daemonset  1/1 Running
```

nodeのallocatableにもGPUが出ました。

```text
k8s-gpu1  GPU=1
```

ここは今回のGPU記事で一番分かりやすい詰まりでした。ホストでGPUが見えても、KubernetesのPodがGPUを見られるとは限りません。

![GPU responsibility boundary](/images/2026-w26-gpu-node/gpu-node-boundary.svg)

## GPU Podでnvidia-smi

最後に、GPUをrequestするPodを作りました。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: gpu-nvidia-smi-test
spec:
  restartPolicy: Never
  runtimeClassName: nvidia
  nodeSelector:
    homelab.local/gpu: "true"
  tolerations:
    - key: nvidia.com/gpu
      operator: Exists
      effect: NoSchedule
  containers:
    - name: cuda
      image: nvidia/cuda:12.6.3-base-ubuntu24.04
      command: ["nvidia-smi"]
      resources:
        limits:
          nvidia.com/gpu: 1
```

結果は成功しました。

```text
NVIDIA-SMI
NVIDIA GeForce RTX 4070
Driver Version: 595.71.05
CUDA Version: 13.2
```

PodはCompletedになりました。これで、Kubernetes上からRTX 4070を使えることを確認できました。

## 最終状態

最終的には、以下の状態になりました。

```text
GPU node:
  Ready
  role: gpu
  Kubernetes: v1.31.14
  containerd: 2.2.1
  GPU allocatable: 1
  taint: nvidia.com/gpu=true:NoSchedule

NVIDIA:
  RTX 4070
  driver: 595.71.05
  CUDA表示: 13.2
  Device Plugin: Running
  RuntimeClass: nvidia
```

既存アプリも確認しました。

```text
Misskey HTTP 200
Harbor HTTP 200
Argo CD HTTP 200
bad pods なし
```

## 学び

GPUノード追加は、GPUだけの作業ではありませんでした。

今回の責任境界はこうでした。

```text
Hardware:
  RTX 4070 / PCIe / PSU

Host OS:
  Ubuntu / NVIDIA driver / nvidia-smi

Container runtime:
  containerd / NVIDIA Container Toolkit

Kubernetes:
  kubelet / RuntimeClass / Device Plugin

Workload:
  resources.limits.nvidia.com/gpu
```

どこか1つが欠けると、PodからGPUは見えません。今回の環境では、Device PluginがCrashLoopBackOffしたことで、RuntimeClassの必要性に気づきました。

次にやるなら、DCGM exporterを入れてGPU温度・使用率・電力をPrometheusで見たいです。ただし、研究の本線としては、すぐLLMに飛ばず、まずはPostgreSQL lock waitのRCA baselineへ進む予定です。
