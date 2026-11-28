"""Verify real tools/list snapshots and captured tools/call results."""
import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator


root, observations = map(Path, sys.argv[1:])


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def structure(value):
    if isinstance(value, list):
        return [structure(item) for item in value]
    if isinstance(value, dict):
        commentary = {"title", "description", "examples"}
        return {key: structure(item) for key, item in value.items()
                if key not in commentary or not isinstance(item, (str, list))}
    return value


profiles = ("full", "studio", "music", "sound", "audition", "patches", "presets", "compact")
declarations = {}
for profile in profiles:
    for locale in ("fr", "en"):
        tools = load(root / f"{profile}-{locale}.json")["tools"]
        declarations[profile, locale] = {tool["name"]: tool for tool in tools}
        for tool in tools:
            input_schema = tool["inputSchema"]
            Draft202012Validator.check_schema(input_schema)
            Draft202012Validator.check_schema(tool["outputSchema"])
            for example in input_schema.get("examples", []):
                Draft202012Validator(input_schema).validate(example)
    assert structure(declarations[profile, "fr"]) == structure(declarations[profile, "en"]), profile

cases = load(observations)
assert cases
for entry in cases:
    tool = declarations[entry["profile"], entry["language"]][entry["name"]]
    Draft202012Validator(tool["inputSchema"]).validate(entry["input"])
    Draft202012Validator(tool["outputSchema"]).validate(entry["output"])
print(f"Validated 16 bilingual toolsets and {len(cases)} captured MCP calls.")
