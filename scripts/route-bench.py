"""Measure tool routing on realistic requests without executing model-generated arguments."""
import argparse
import json
import os
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

from jsonschema import Draft202012Validator


ROOT = Path(__file__).resolve().parents[1]
CASES = [
    ("Fais-moi écouter le nuancier du piano et de la harpe en un seul fichier.",
     "Play the piano and harp catalog examples in a single file.", "play_sound", "audition_sound", {"mode": "catalog"}),
    ("Compare la flûte et la clarinette à l’aveugle sur les mêmes notes.",
     "Blind-compare flute and clarinet on the same notes.", "compare_sounds", "audition_sound", {"mode": "comparison", "blind": True}),
    ("Mesure la sonie et les crêtes de master.wav.",
     "Measure loudness and peaks in master.wav.", "analyze_music", "analyze_music", {"wav_path": "master.wav"}),
    ("Propose deux versions d’un thème instrumental de vingt secondes au piano.",
     "Draft two instrumental versions of a twenty-second piano theme.", "draft_music", "draft_music", {"variants": 2}),
    ("Exporte le projet theme.soundmcp.json en MIDI.",
     "Export the saved theme.soundmcp.json project to MIDI.", "finish_music", "finish_music", {"format": "midi"}),
    ("Prépare une boucle de pluie de dix secondes.",
     "Render a ten-second looping rain bed.", "create_ambience", "render_preset", {"mode": "ambience", "kind": "rain"}),
    ("Crée un effet ponctuel de pièce.",
     "Render a one-shot coin effect.", "create_sfx", "render_preset", {"mode": "effect", "kind": "coin"}),
    ("Fais des variantes plus brillantes de cuivre.soundmcp-patch.json.",
     "Make brighter variations of cuivre.soundmcp-patch.json.", "vary_sound", "design_timbre", {"mode": "vary"}),
]


def listing(profile, locale):
    request = dict(jsonrpc="2.0", id=1, method="tools/list", params={})
    result = subprocess.run(["node", str(ROOT / "src" / "index.js")], input=json.dumps(request) + "\n",
                            text=True, encoding="utf-8", capture_output=True, check=True,
                            env=dict(os.environ, SOUNDMCP_TOOLSET=profile, SOUNDMCP_LANG=locale))
    return {tool["name"]: tool for tool in json.loads(result.stdout)["result"]["tools"]}


def tool_summary(tool):
    schema = tool["inputSchema"]
    summary = {"name": tool["name"], "description": tool["description"], "required": schema.get("required", []),
               "parameters": {name: {key: field[key] for key in ("type", "enum", "description") if key in field}
                              for name, field in schema["properties"].items()}}
    modes = {}
    for branch in schema.get("oneOf", []):
        mode = branch.get("properties", {}).get("mode", {}).get("const")
        if mode:
            modes[mode] = {"required": branch.get("required", []), "allowed": list(branch["properties"])}
    if modes:
        summary["modes"] = modes
        summary["examples"] = schema["examples"]
    return summary


def submit(options, prompt):
    result_schema = {"type": "object", "required": ["name", "arguments"],
                     "properties": {"name": {"type": "string"}, "arguments": {"type": "object", "additionalProperties": True}}}
    body = {"model": options.model, "think": False, "stream": False, "format": result_schema,
            "options": {"temperature": 0, "seed": 7, "num_ctx": 24576, "num_predict": 640},
            "messages": [
                {"role": "system", "content": "Choose one MCP tool and return only JSON with name and arguments. "
                                             "Use the declared parameter names, enum values and required fields for the selected mode. "
                                             "Omit optional arguments unless the request calls for them. Do not call any tool."},
                {"role": "user", "content": prompt},
            ]}
    http = urllib.request.Request(options.endpoint, data=json.dumps(body).encode(),
                                  headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(http, timeout=90) as response:
            return json.loads(json.load(response)["message"]["content"])
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Ollama returned {error.code}: {error.read(400).decode(errors='replace')}") from error


def repair_schema(schema, args):
    mode = args.get("mode") if isinstance(args, dict) else None
    branch = next((entry for entry in schema.get("oneOf", [])
                   if mode and entry.get("properties", {}).get("mode", {}).get("const") == mode), schema)
    return {"required": branch.get("required", []), "properties": {
        name: {key: field[key] for key in ("type", "enum", "required") if key in field}
        for name, field in branch.get("properties", {}).items()
    }}


def evaluate(options, profile, locale, cases):
    tools = listing(profile, locale)
    reference = json.dumps([tool_summary(tool) for tool in tools.values()], ensure_ascii=False)
    runs = []
    for fr, en, full, compact, fields in cases:
        text = fr if locale == "fr" else en
        expected = compact if profile == "compact" else full
        expected_fields = {k: v for k, v in fields.items() if k != "mode" or profile == "compact"}
        feedback = ""
        attempts = []
        for _ in range(options.attempts):
            try:
                result = submit(options, f"Tools\n{reference}\nRequest\n{text}\n{feedback}")
            except (RuntimeError, ValueError, KeyError, OSError) as error:
                attempts.append({"name": None, "arguments": None, "correct_tool": False, "valid_arguments": False,
                                 "matches_request": False, "provider_error": str(error)})
                continue
            if not isinstance(result, dict):
                result = {}
            name, args = result.get("name"), result.get("arguments")
            schema_tool = tools.get(name) if isinstance(name, str) else None
            errors = ["unknown tool or missing arguments"] if not schema_tool or not isinstance(args, dict) else [
                error.message for error in Draft202012Validator(schema_tool["inputSchema"]).iter_errors(args)]
            correct_tool = name == expected
            correct_arguments = isinstance(args, dict) and all(args.get(k) == v for k, v in expected_fields.items())
            attempts.append({"name": name, "arguments": args, "correct_tool": correct_tool,
                             "valid_arguments": not errors, "matches_request": correct_arguments})
            if correct_tool and not errors and correct_arguments:
                break
            chosen_schema = repair_schema(schema_tool["inputSchema"], args) if schema_tool else {}
            feedback = "Reconsider your choice and parameters. " + " ".join(error[:240] for error in errors[:2]) + "\n" + json.dumps(chosen_schema)
        runs.append({"request": text, "expected": expected, "attempts": attempts})
    return {
        "profile": profile, "language": locale, "cases": runs,
        "correct_first_tool": sum(run["attempts"][0]["correct_tool"] for run in runs),
        "valid_first_arguments": sum(run["attempts"][0]["valid_arguments"] for run in runs),
        "completed": sum(all(run["attempts"][-1][key] for key in
                             ("correct_tool", "valid_arguments", "matches_request")) for run in runs),
        "total_attempts": sum(len(run["attempts"]) for run in runs),
        "provider_errors": sum("provider_error" in attempt for run in runs for attempt in run["attempts"]),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--endpoint", default="http://127.0.0.1:11434/api/chat")
    parser.add_argument("--profiles", nargs="+", choices=("full", "compact"), default=["full", "compact"])
    parser.add_argument("--languages", nargs="+", choices=("fr", "en"), default=["fr", "en"])
    parser.add_argument("--attempts", type=int, choices=(1, 2, 3), default=2)
    parser.add_argument("--limit", type=int, choices=range(1, len(CASES) + 1), default=len(CASES))
    parser.add_argument("--output", type=Path, default=ROOT / "tmp" / "route-bench.json")
    options = parser.parse_args()
    report = {"model": options.model, "runs": []}
    options.output.parent.mkdir(parents=True, exist_ok=True)
    for profile in options.profiles:
        for language in options.languages:
            run = evaluate(options, profile, language, CASES[:options.limit])
            report["runs"].append(run)
            options.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print({k: v for k, v in run.items() if k != "cases"}, flush=True)


if __name__ == "__main__":
    main()
