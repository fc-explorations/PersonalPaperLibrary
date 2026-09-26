# Scratchpad

## To do

- Add an “Interesting articles” mode from the Add button. Let the user enter a topic or ask a generative OpenAI model to infer two or three topic prompts by analyzing abstracts from a recent arXiv sample (initially around 100 Computer Science papers). Search recent arXiv entries over a selectable period, score candidates against the chosen topic with Jev's typed Decisions API, let the user review and select results, then import the selected papers and available PDFs. Give classification its own Settings entry with OpenRouter as its provider and a separate model setting, initially `~typesafe/jev-latest` (Jev Latest); leave the existing AI provider/model settings for summaries, questions, and semantic search unchanged.

## Working on

## Done

- Add secure OpenRouter key entry to local Settings and show hosted Worker Secret status. [2026-09-26 09:45]
