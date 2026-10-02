import type { QuestionDefinition } from "../types.js";

/** Generated from config/questions.yaml for the Cloudflare Worker runtime. */
export const hostedQuestionDefinitions: QuestionDefinition[] = [
  {
    id: "evaluate_main_claim", groupId: "evaluate", groupTitle: "Evaluate", groupDescription: "Understand the paper's claim, reasoning, evidence, and limits.",
    label: "What problem does the paper address, and what central claim does it make?",
    prompt: "Answer in four short parts: Problem, Setting, Central claim, and Claim type. State the central claim in one precise sentence and identify whether it is empirical, theoretical, methodological, conceptual, practical, or interpretive. Include the target task, population, or regime when the paper specifies one. Distinguish the paper's stated claim from your interpretation. Do not list secondary contributions. If the paper does not make a single central claim, say so and identify the two most important claims. Mark details as insufficient when the supplied paper text does not establish them.",
    order: 0, definitionHash: "4ba6eeb1976dbfe958bef7cc21edaffaa9afc5ccedb95e8aa7dfa5a05f2b4a81",
  },
  {
    id: "understand_method", groupId: "evaluate", groupTitle: "Evaluate", groupDescription: "Understand the paper's claim, reasoning, evidence, and limits.",
    label: "How was the idea implemented or argued?",
    prompt: "Explain the method or argument in at most five numbered steps, followed by one short paragraph on why it should support the central claim. Adapt to the paper type: describe the algorithm and data flow for empirical ML, the logical structure and assumptions for theory, the architecture and operating constraints for systems, and the interpretive framework for qualitative or conceptual work. Separate what the paper explicitly establishes from what is only a proposed rationale. Say Not applicable when there is no method or mechanism to explain.",
    order: 1, definitionHash: "337bce36b947fe3d5aa16285788b4b0447208a06bdae557f229769029e6be60a",
  },
  {
    id: "understand_assumptions", groupId: "evaluate", groupTitle: "Evaluate", groupDescription: "Understand the paper's claim, reasoning, evidence, and limits.",
    label: "What consequential assumptions does the paper rely on?",
    prompt: "List at most four consequential assumptions. For each, state: Assumption, where it appears, whether the paper tests or simply adopts it, and how violating it could affect the central claim. Cover data, modeling, causal, theoretical, measurement, or interpretive assumptions as applicable. Do not infer an assumption solely from general field practice; say insufficient information when the paper does not support one.",
    order: 2, definitionHash: "02f27885a45c7f88852cf3b233e6f1525f7db806173e664488942e2927361ae1",
  },
  {
    id: "evaluate_claim_evidence", groupId: "evaluate", groupTitle: "Evaluate", groupDescription: "Understand the paper's claim, reasoning, evidence, and limits.",
    label: "What evidence supports the main claim?",
    prompt: "Return a claim-evidence table with at most five rows and columns: Claim component, evidence from the paper, section or location, what it establishes, and what it does not establish. Separate primary evidence from supporting or boundary evidence. Adapt to the paper type: experiments, proofs, observations, case material, or conceptual analysis. Do not treat an assertion, citation, or illustrative example as a direct test unless the paper makes it one. Say insufficient information where a direct test is absent.",
    order: 3, definitionHash: "16a83d44719a11bd23927401f7e6e23021210d39179922200927645010d4e402",
  },
  {
    id: "evaluate_allowable_conclusion", groupId: "evaluate", groupTitle: "Evaluate", groupDescription: "Understand the paper's claim, reasoning, evidence, and limits.",
    label: "What conclusion is actually justified?",
    prompt: "Use four headings: Strongest justified conclusion, Scope, What remains unsupported, and Evidence basis. Rewrite the paper's conclusion in a defensible form if it is broader than the evidence. Distinguish local, general, regime-specific, mechanism-supported, practical, and exploratory conclusions. State the key uncertainty rather than assigning an unsupported numerical confidence. Do not penalize the paper for evidence that is not applicable to its type.",
    order: 4, definitionHash: "9ef298b8abebd326b9af9992e50b4b5a70bed58629c5918dfcb9f873bd890c33",
  },
  {
    id: "evaluate_failure_modes", groupId: "evaluate", groupTitle: "Evaluate", groupDescription: "Understand the paper's claim, reasoning, evidence, and limits.",
    label: "Where could the argument fail, and how robust is it?",
    prompt: "Identify at most four consequential failure modes or transfer limits. For each, give: Failure mode, paper claim affected, whether it is tested, and why it matters. Consider weak assumptions, missing controls, leakage, alternative explanations, narrow evaluation, sensitivity, repetitions, distribution shift, or untested mechanisms as applicable. Do not invent a criticism merely because a standard check is absent; say insufficient information when the paper text does not support one.",
    order: 5, definitionHash: "14e2ee9318217b9f12749ebc1754191c0043557f69b731c8b8c9418da3ba606f",
  },
  {
    id: "compare_gap", groupId: "compare", groupTitle: "Compare", groupDescription: "Position the paper against prior work and competing explanations.",
    label: "What gap and novelty does the paper claim?",
    prompt: "State the gap the paper claims to address, what existing work or assumption it says is insufficient, and what it presents as novel. Distinguish a new idea, method, framing, combination, empirical result, or exposition. Then assess whether the supplied paper text supports the claimed importance and novelty. Do not claim to establish genuine field-wide novelty when the supplied references or literature context are incomplete.",
    order: 6, definitionHash: "e4c5a3eed718532a309dabc56a70bf4c444c91ef5c1edfa8d819d1136d51346f",
  },
  {
    id: "compare_baselines", groupId: "compare", groupTitle: "Compare", groupDescription: "Position the paper against prior work and competing explanations.",
    label: "Are the important alternatives and comparisons covered?",
    prompt: "Assess whether the paper compares itself against the right alternatives. Consider baselines, prior frameworks, methods, examples, datasets, theories, controls, and competing explanations. Identify the single most important missing comparison, if there is one, and explain what uncertainty it would resolve. Say when comparison is not applicable to the paper type.",
    order: 7, definitionHash: "6cabafc0d3460c5f2d0ddea35f76d65bcf5269e833ef1dba2790bb53dd5aa028",
  },
  {
    id: "compare_key_references", groupId: "compare", groupTitle: "Compare", groupDescription: "Position the paper against prior work and competing explanations.",
    label: "What are the most important references for understanding and extending this work?",
    prompt: "Select at most six cited works visible in the supplied paper text. For each, give the citation text as written, its role (problem, method, baseline, background, or contrast), why it matters for interpreting this paper, and whether it is a useful starting point for expanding the literature. Do not invent authors, titles, years, or claims. Do not treat the selected citations as a complete literature review. If the references section is incomplete or unreadable, say so.",
    order: 8, definitionHash: "e15fcd54e0c2c5582a13e61bf282bffe7bf2ff92dc2ff1312d3d652a34bc9d32",
  },
  {
    id: "review_strength", groupId: "review", groupTitle: "Review", groupDescription: "Decide what is worth remembering, challenging, and improving.",
    label: "Why is this paper worth remembering?",
    prompt: "Give one strongest contribution and one sentence explaining why it matters to a future reader. State the most useful takeaway to retain from the paper. Ground it in the problem, method, evidence, or framework. Do not predict influence or practical impact unless the paper provides evidence for it. Say insufficient information if the paper's value cannot be assessed from the supplied text.",
    order: 9, definitionHash: "14fecf1ec8beed7cde9ba738b23d0a51ef77e799951465c2bc2d9ada937b1eae",
  },
  {
    id: "review_weakness", groupId: "review", groupTitle: "Review", groupDescription: "Decide what is worth remembering, challenging, and improving.",
    label: "What is the most consequential limitation?",
    prompt: "Identify the single most consequential limitation. Use the headings Limitation, Evidence, Claim affected, and Consequence. Prefer a limitation supported by the paper over a generic missing best practice. Consider reproducibility, data quality, measurement, ethics, safety, or deployment constraints when they materially affect the claim. Do not list minor issues or manufacture a criticism.",
    order: 10, definitionHash: "13642a6bf77fdf3582ccd822ba0e213212df4d7bb351b99ea4066fca6a6a7e1e",
  },
  {
    id: "review_reproducibility", groupId: "review", groupTitle: "Review", groupDescription: "Decide what is worth remembering, challenging, and improving.",
    label: "Could someone reproduce or responsibly use this work?",
    prompt: "Assess reproducibility and responsible use in at most five bullets. Cover the availability and specificity of data, code, model or system details, hyperparameters or protocol, evaluation materials, licenses, and any ethical, privacy, safety, or deployment constraints that the paper makes relevant. Separate information the paper provides, information it says is available elsewhere, and information that is missing. Say Not applicable when a dimension does not apply.",
    order: 11, definitionHash: "e4ee511756a1805c8e946e69e05efa866ba0f6fc60069d318240c89ee114dead",
  },
  {
    id: "review_decisive_fix", groupId: "review", groupTitle: "Review", groupDescription: "Decide what is worth remembering, challenging, and improving.",
    label: "What one change would most change the assessment?",
    prompt: "Propose one discriminating next step: experiment, analysis, proof, example, comparison, clarification, or reframing. State the unresolved uncertainty it addresses, the claim it would test or strengthen, and what result would change the assessment. Keep it feasible and do not assume resources or evidence absent from the paper. If the paper is already well supported, propose the most useful extension rather than inventing a defect.",
    order: 12, definitionHash: "5bf641a3411ced1b94a82e8800c3970a858c8f27628288d62c3d312e4620eee0",
  },
];
