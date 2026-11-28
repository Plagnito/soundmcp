"""Compare repeated TDQS reports from the same rubric and model."""
import argparse
import json
import statistics
from pathlib import Path


def load(file):
    data = json.loads(file.read_text(encoding="utf-8-sig"))
    report = data.get("score", data)
    if not report or not report.get("serverScore"):
        raise SystemExit(f"No completed TDQS score in {file}")
    return report


def summarize(reports):
    totals = [entry["serverScore"]["overallScore"] for entry in reports]
    coherence = [entry["serverScore"]["coherenceScore"] for entry in reports]
    floors = [min(tool["tdqs"] for tool in entry["tools"]) for entry in reports]
    names = ("disambiguation", "namingConsistency", "toolCountAppropriateness", "completeness")
    axes = {name: [entry["serverScore"][name] for entry in reports] for name in names}
    per_tool = {}
    for entry in reports:
        for tool in entry["tools"]:
            per_tool.setdefault(tool["name"], []).append({"tdqs": tool["tdqs"], "axes": tool.get("scores", {})})
    return {"overall": totals, "overall_median": statistics.median(totals), "coherence": coherence, "minimum_tool": floors,
            "definition_quality": [entry["serverScore"]["descriptionQualityScore"] for entry in reports],
            "coherence_axes": axes, "tool_scores": per_tool}


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--reference", type=Path, nargs="+", required=True)
parser.add_argument("--candidate", type=Path, nargs="+", required=True)
parser.add_argument("--minimum", type=float)
options = parser.parse_args()
reference = [load(path) for path in options.reference]
candidate = [load(path) for path in options.candidate]
fingerprints = {(report["specVersion"], report.get("model")) for report in reference + candidate}
if len(fingerprints) != 1:
    raise SystemExit("Use the same TDQS specification and model for all comparisons.")
before, after = summarize(reference), summarize(candidate)
print(json.dumps({"reference": before, "candidate": after}, indent=2))
if options.minimum is not None and min(after["overall"]) < options.minimum:
    raise SystemExit(f"At least one candidate run was below {options.minimum:.1f}")
