extends Control

const INTRO := 0
const FIRST_LOOP := 1
const SECOND_LOOP := 2
const OUTRO := 3

@onready var audio: AudioStreamPlayer = $Audio
@onready var finish_timer: Timer = $FinishTimer
@onready var picker: FileDialog = $Picker
@onready var current: Label = %Current
@onready var details: Label = %Details
@onready var play_button: Button = %Play
@onready var exit_button: Button = %ExitLoop

var exit_queued := false
var load_error := ""

func _ready() -> void:
	%Open.pressed.connect(func() -> void: picker.popup_centered())
	picker.file_selected.connect(load_pack)
	play_button.pressed.connect(play)
	exit_button.pressed.connect(queue_exit)
	finish_timer.timeout.connect(finish_playback)
	var args := OS.get_cmdline_user_args()
	if args.size() == 2 and args[0] == "--self-test":
		run_self_test.call_deferred(args[1])
	elif args.size() == 1:
		load_pack(args[0])
	elif FileAccess.file_exists("res://generated/current.txt"):
		var relative := FileAccess.get_file_as_string("res://generated/current.txt").strip_edges()
		load_pack(ProjectSettings.globalize_path("res://generated".path_join(relative)))

func load_pack(manifest_path: String) -> bool:
	if not FileAccess.file_exists(manifest_path):
		return fail_load("Le manifeste est introuvable.")
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(manifest_path))
	if not parsed is Dictionary or parsed.get("type") != "soundmcp-adaptive" or parsed.get("version") != 1:
		return fail_load("Le fichier n’est pas un manifeste SoundMCP adaptatif v1.")
	var segments: Variant = parsed.get("segments")
	var sample_rate := int(parsed.get("sample_rate", 0))
	var channels := int(parsed.get("channels", 0))
	if not segments is Dictionary or sample_rate <= 0 or channels not in [1, 2]:
		return fail_load("Le manifeste contient des paramètres audio invalides.")
	var sounds: Array[AudioStreamWAV] = []
	var next_frame := 0
	for segment_name in ["intro", "loop", "outro"]:
		var entry: Variant = segments.get(segment_name)
		if not entry is Dictionary:
			return fail_load("Segment manquant dans le manifeste. " + segment_name)
		var file_name := str(entry.get("file", ""))
		var frames := int(entry.get("frames", 0))
		if file_name.is_empty() or file_name.get_file() != file_name or file_name.is_absolute_path() \
				or file_name.contains("\\") or file_name.contains(":") or not file_name.ends_with(".wav") \
				or frames <= 0 or int(entry.get("start_sample", -1)) != next_frame:
			return fail_load("Chemin ou raccord invalide. " + segment_name)
		next_frame += frames
		if int(entry.get("end_sample_exclusive", -1)) != next_frame:
			return fail_load("Longueur incohérente dans le manifeste. " + segment_name)
		var sound := AudioStreamWAV.load_from_file(manifest_path.get_base_dir().path_join(file_name))
		if sound == null or sound.mix_rate != sample_rate or sound.stereo != (channels == 2) \
				or roundi(sound.get_length() * sample_rate) != frames:
			return fail_load("Le WAV ne correspond pas au manifeste. " + file_name)
		sound.loop_mode = AudioStreamWAV.LOOP_DISABLED
		sounds.append(sound)
	if next_frame != int(parsed.get("total_frames", -1)):
		return fail_load("Durée totale incohérente dans le manifeste.")

	var stream := AudioStreamInteractive.new()
	stream.clip_count = 4
	stream.initial_clip = INTRO
	stream.set_clip_stream(INTRO, sounds[0])
	stream.set_clip_stream(FIRST_LOOP, sounds[1])
	stream.set_clip_stream(SECOND_LOOP, sounds[1])
	stream.set_clip_stream(OUTRO, sounds[2])
	add_next_clip(stream, INTRO, FIRST_LOOP)
	add_next_clip(stream, FIRST_LOOP, SECOND_LOOP)
	add_next_clip(stream, SECOND_LOOP, FIRST_LOOP)
	add_transition(stream, FIRST_LOOP, OUTRO)
	add_transition(stream, SECOND_LOOP, OUTRO)
	finish_timer.stop()
	audio.stop()
	audio.stream = stream
	exit_queued = false
	load_error = ""
	current.text = "Prêt à jouer"
	details.text = "Boucle de %.2f s · %d Hz. La sortie attend la fin d’un tour." % [sounds[1].get_length(), sample_rate]
	play_button.disabled = false
	return true

func add_next_clip(stream: AudioStreamInteractive, from: int, to: int) -> void:
	add_transition(stream, from, to)
	stream.set_clip_auto_advance_next_clip(from, to)
	stream.set_clip_auto_advance(from, AudioStreamInteractive.AUTO_ADVANCE_ENABLED)

func add_transition(stream: AudioStreamInteractive, from: int, to: int) -> void:
	stream.add_transition(from, to, AudioStreamInteractive.TRANSITION_FROM_TIME_END, \
		AudioStreamInteractive.TRANSITION_TO_TIME_START, AudioStreamInteractive.FADE_DISABLED, 0.0)

func fail_load(message: String) -> bool:
	load_error = message
	details.text = message
	return false

func play() -> void:
	if audio.stream == null:
		return
	finish_timer.stop()
	audio.stop()
	exit_queued = false
	audio.play()

func queue_exit() -> void:
	if not audio.has_stream_playback():
		return
	var playback := audio.get_stream_playback() as AudioStreamPlaybackInteractive
	if playback and playback.get_current_clip_index() in [FIRST_LOOP, SECOND_LOOP] and not exit_queued:
		exit_queued = true
		playback.switch_to_clip(OUTRO)

func _process(_delta: float) -> void:
	if not audio.playing or not audio.has_stream_playback():
		exit_button.disabled = true
		return
	var playback := audio.get_stream_playback() as AudioStreamPlaybackInteractive
	var clip := playback.get_current_clip_index()
	exit_button.disabled = clip not in [FIRST_LOOP, SECOND_LOOP] or exit_queued
	match clip:
		INTRO: current.text = "Introduction"
		FIRST_LOOP, SECOND_LOOP: current.text = "Sortie au prochain raccord" if exit_queued else "Boucle"
		OUTRO:
			if finish_timer.is_stopped():
				current.text = "Sortie"
				var stream := audio.stream as AudioStreamInteractive
				finish_timer.start(stream.get_clip_stream(OUTRO).get_length() + 0.1)

func finish_playback() -> void:
	audio.stop()
	current.text = "Lecture terminée"

func wait_for_clip(target: int, seconds: float) -> bool:
	var until := Time.get_ticks_msec() + int(seconds * 1000)
	while Time.get_ticks_msec() < until:
		if audio.has_stream_playback():
			var playback := audio.get_stream_playback() as AudioStreamPlaybackInteractive
			if playback and playback.get_current_clip_index() == target:
				return true
		await get_tree().process_frame
	return false

func run_self_test(manifest_path: String) -> void:
	if not load_pack(manifest_path):
		push_error(load_error)
		get_tree().quit(1)
		return
	play()
	var intro_ok := await wait_for_clip(INTRO, 1)
	var first_ok := await wait_for_clip(FIRST_LOOP, 5)
	var repeat_ok := await wait_for_clip(SECOND_LOOP, 7)
	queue_exit()
	var outro_ok := await wait_for_clip(OUTRO, 7)
	var completed := false
	if outro_ok:
		var stream := audio.stream as AudioStreamInteractive
		var until := Time.get_ticks_msec() + int((stream.get_clip_stream(OUTRO).get_length() + 2) * 1000)
		while audio.playing and Time.get_ticks_msec() < until:
			await get_tree().process_frame
		completed = not audio.playing
	audio.stop()
	audio.stream = null
	await get_tree().create_timer(0.1).timeout
	if not (intro_ok and first_ok and repeat_ok and outro_ok and completed):
		push_error("Séquence adaptative incorrecte. Intro %s, boucle %s, répétition %s, sortie %s, arrêt %s." % [intro_ok, first_ok, repeat_ok, outro_ok, completed])
		get_tree().quit(1)
		return
	print("Godot · introduction, boucle, répétition, sortie et arrêt vérifiés.")
	get_tree().quit()
