from pathlib import Path
import hashlib

EXPECTED = {'.gitignore': 'cbadb636d2d64d5c05c697faafd9e304c6c2a9f4', 'AGENTS.md': 'be077955ab523d91c01b489b9bbeb515b9a83903', 'README.md': 'b20a35fda50721631150e42c91837ff985130c98', 'apps/web/index.html': 'b10fbca6504de792f8e07148cb90eb1fa02d35d8', 'apps/web/package.json': 'f0def9a5190f6e9b885f1d26d59f15708da6ca21', 'apps/web/src/App.tsx': '44b0762145106d701b2be93ed0b04485a42bac97', 'apps/web/src/components/Dashboard.tsx': '15c7a4529c0383f009d9190752be20877aee4228', 'apps/web/src/components/Inspector.tsx': 'e9b47f33181f6cfe0c0466cf25c40e0ce222b0cc', 'apps/web/src/components/PlaybackBar.tsx': '172091742109231560b798d2d691a7b8f80bd2a3', 'apps/web/src/components/RecoveryScene.tsx': '12813630cd5999815c224ef816af706f2fe67845', 'apps/web/src/components/TelemetryCharts.tsx': '81355ae7497101c7e267ba73c3413508b541783c', 'apps/web/src/components/index.ts': '3d04b61e955d880d13c9e4ccf3d7709e1ceee149', 'apps/web/src/dashboard.css': 'abf14eb934572d53a5e865d374231e24ff10bdae', 'apps/web/src/main.tsx': '33837d7831bc26b0439e50ea0eab67525282332f', 'apps/web/src/styles.css': '8f333a6fd8adec988c79c3cbf0baaa49992b7b24', 'apps/web/tsconfig.app.json': '852d643f2dfa79db7234349d4a7abfcd21fee3f4', 'apps/web/tsconfig.json': '1ffef600d959ec9e396d5a260bd3f5b927b2cef8', 'apps/web/tsconfig.node.json': 'c66da8a17d589dbe19576cccedfbb83885af9dfa', 'apps/web/vite.config.ts': '4c0ed25ee8b7f81846328d822895ffd05f3a35eb', 'docs/公开资料与模型边界.md': '93702061177282c7842c103a4102f490b9df6d1b', 'docs/系统架构设计.md': 'fc08e2db204fc226146fcb1dd89da44bc78b8a1e', 'docs/验证计划.md': 'b8721d14d192dc96956f7181d880e12ada296e54', 'package-lock.json': '1a8fdf762a840064028ab701ba1c53b08f88304e', 'package.json': 'bbac8bd7f93106f97efb65b41f42406b394c637a', 'packages/sim-core/package.json': '382d512f656dbd61782b4ee566b4c6fb70909247', 'packages/sim-core/src/comms/network.ts': 'fd56847618e474118e6e0ba1835448e4b66b8d1e', 'packages/sim-core/src/comms/protocol.ts': '8e5f3aef569b412ad392ef0f92b4cc65d3109b27', 'packages/sim-core/src/config.ts': 'df401e60984fe9f45bd87f0819e12ebc13d95a6b', 'packages/sim-core/src/contracts.ts': 'f7749d6fd1950888b4a5ea69e2be6f9d7b308369', 'packages/sim-core/src/control.ts': 'f33cb3ad62d9a70631b54bb119504d775101ab2a', 'packages/sim-core/src/engine/rng.ts': 'f5028f48b211bcf38d05bebb0a47e68c7ab7af07', 'packages/sim-core/src/estimation.ts': '4658e1125848a3d07822ea25cad0c89665d6c502', 'packages/sim-core/src/experiments.ts': 'd02b2fbbc09d092bfe44e51665fb55210301d0d7', 'packages/sim-core/src/index.ts': '7552cbbb26ea9f3af36de2cacafc4a679c97f7ec', 'packages/sim-core/src/math.ts': '75e17d01a9b46338d372cd86a8cdb48413896d95', 'packages/sim-core/src/metrics.ts': '1b300d5933f3d590d1b3dd4b4965ce3818f3cea2', 'packages/sim-core/src/plant.ts': '19c9a9ddc79cc9ef8fdbbd6584a78e245f142339', 'packages/sim-core/src/sensors.ts': '28a6de5d0e27a14275fcca0874315d85506ee8a0', 'packages/sim-core/src/simulation.ts': '3b023497c95f54ddc413cc720557f3593d942604', 'packages/sim-core/tests/comms.test.ts': '9826644573ca2ff56d8f992c41cb4988190e3878', 'packages/sim-core/tests/control.test.ts': '77492568c6c75727345fa1ed086a4a9dd29fb87a', 'packages/sim-core/tests/experiments.test.ts': '28c88b79066a4cb5b6f5f9cd99bffddcb927ebd3', 'packages/sim-core/tests/metrics.test.ts': '491b285c6d35aac3b2cbfa0c788ed19387309611', 'packages/sim-core/tests/plant.test.ts': 'd6dde4d6d49b406fca4604a0c4f9fe57329bc495', 'packages/sim-core/tests/sensors.test.ts': 'f58a8c18012a0b1a7b84c3ee42c83991182b8eb5', 'packages/sim-core/tests/simulation.test.ts': 'dec2d0cf16da34255246af505fec85cbb8093f93', 'packages/sim-core/tsconfig.json': 'ee2fd92dae15057b76b179e00cd18cacabb96029', 'tools/run-monte-carlo.ts': '6478855ec3b9848430e9b7e7eb4e676555289d0c', 'tools/run-scenario.ts': 'cd10e83c48f99b6a1a0c2e627cc5f04f23f6c4e7', 'tsconfig.base.json': 'e9209701754fcc77ad6101b61f0b8347b5fc3144', 'vitest.config.ts': '9e2a86305748dd57ce5fa8118f4a886015ac971d'}

def blob_sha(data: bytes) -> str:
    return hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()

root = Path('.')
normalized = []
for rel, expected in EXPECTED.items():
    path = root / rel
    if not path.is_file():
        raise SystemExit(f"缺少基线文件: {rel}")
    data = path.read_bytes()
    if blob_sha(data) == expected:
        continue
    if data.endswith(b"\n\n") and blob_sha(data[:-1]) == expected:
        path.write_bytes(data[:-1])
        normalized.append(rel)
        continue
    raise SystemExit(f"无法将远端基线规范化到接管基线: {rel}")
print(f"已规范化 {len(normalized)} 个远端文本文件")
