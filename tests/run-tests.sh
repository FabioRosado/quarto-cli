#!/bin/zsh

export QUARTO_ACTION=test
export QUARTO_IMPORT_MAP=$(realpath ../src/import_map.json)
export QUARTO_TARGET=""

quarto $@