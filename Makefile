# wakekit — the training pipeline as runnable documentation.
#
#   make help          this list
#   make train-lada    end-to-end worked example: corpus → features → head → eval
#
# Train a NEW wake word (any language):
#   1. cp scripts/corpus-lada.sh scripts/corpus-yourword.sh
#      — swap POS_TEXT (your wake word), HARD (words in your language that RHYME with it —
#        the decisive negatives) and NEG (everyday sentences), point it at your TTS.
#   2. make corpus  CORPUS_SCRIPT=scripts/corpus-yourword.sh
#   3. make features
#   4. make head    HEAD=models/yourword.onnx
#   5. make eval    HEAD=models/yourword.onnx THRESHOLD=0.95
#      — read recall + false-fires/min on the held-out voices, pick the bar that clears both,
#        then add {id,label,lang,file,threshold,note} to models/manifest.json. Done: the demo
#        picker and the library see it with no code change.
#
# Full guide with the ละดา case study and the measurement methodology: docs/training.md

CORPUS_SCRIPT ?= scripts/corpus-lada.sh
CORPUS_DIR    ?= corpus
FEAT_DIR      ?= features
HEAD          ?= models/lada.onnx
THRESHOLD     ?= 0.95
NEG_WEIGHT    ?= 20

.PHONY: help corpus features head eval selfcheck dev build train-lada

help:
	@awk '/^# {3}|^#$$|^# [0-9T]/{sub(/^# ?/,"");print}' Makefile

## corpus: generate TTS clips (needs your TTS CLI + ffmpeg; resumable, skips existing clips)
corpus:
	bash $(CORPUS_SCRIPT) $(CORPUS_DIR)

## features: corpus/ → X.bin/y.bin — the 1536-d windows the head actually trains on (~minutes)
features:
	node scripts/featurize.mjs $(CORPUS_DIR)/corpus $(FEAT_DIR)

## head: train the ~110k-param head with numpy only (no GPU, no torch), export ONNX
head:
	python3 scripts/train.py $(FEAT_DIR) $(HEAD) --neg-weight $(NEG_WEIGHT)

## eval: recall + false-fires-per-minute over held-out clips — the two numbers that decide shipping
eval:
	node scripts/eval.mjs eval/clips $(HEAD) $(THRESHOLD)

## selfcheck: drive the real worker over the real models; asserts pos_/neg_ clips when present
selfcheck:
	npm run selfcheck

## dev / build: the test page
dev:
	npm run dev
build:
	npm run build

# The worked example, end to end. eval/clips is the held-out set the corpus script writes —
# 4 voices never seen in training, so the numbers mean "unseen speaker", not "rerun".
train-lada: corpus
	node scripts/featurize.mjs $(CORPUS_DIR)/corpus $(FEAT_DIR)
	python3 scripts/train.py $(FEAT_DIR) models/lada.onnx --neg-weight $(NEG_WEIGHT)
	mkdir -p eval/clips
	cp $(CORPUS_DIR)/holdout/pos/*.16k.wav eval/clips/ 2>/dev/null && \
	  cd eval/clips && for f in *_p*.16k.wav; do mv "$$f" "pos_$${f%.16k.wav}.wav" 2>/dev/null; done; true
	cp $(CORPUS_DIR)/holdout/hard/*.16k.wav eval/clips/ 2>/dev/null && \
	  cd eval/clips && for f in *_h*.16k.wav; do mv "$$f" "neg_$${f%.16k.wav}.wav" 2>/dev/null; done; true
	cp $(CORPUS_DIR)/holdout/neg/*.16k.wav eval/clips/ 2>/dev/null && \
	  cd eval/clips && for f in *_n*.16k.wav; do mv "$$f" "neg_$${f%.16k.wav}.wav" 2>/dev/null; done; true
	node scripts/eval.mjs eval/clips models/lada.onnx $(THRESHOLD)
