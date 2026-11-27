# Musique adaptative SoundMCP dans Godot

Ouvre `project.godot` dans Godot 4.5 ou plus récent et lance la scène principale. Choisis un manifeste `*-adaptive.json` et laisse les trois WAV associés dans le même dossier. **Jouer** lance l’introduction et fait tourner la boucle. **Sortir de la boucle** joue la coda au prochain raccord.

Pour générer la piste de démonstration depuis le dépôt SoundMCP, utilise cette commande à sa racine.

```sh
node examples/godot-adaptive/prepare-demo.js
```

La scène charge automatiquement cette piste lorsqu’elle trouve `generated/current.txt`. Dans une exportation de la démonstration avec ses WAV inclus, ces fichiers restent sous `generated/`.

Tu peux aussi demander à SoundMCP de découper ton propre projet.

```sh
node src/cli.js finish projet.soundmcp.json --adaptive 3:8 --wav --no-stems
```

La boucle commence ici à la troisième mesure et dure huit mesures. Les mesures précédentes composent l’introduction et les suivantes forment la sortie. Godot lit les trois WAV avec `AudioStreamInteractive` et déclenche les transitions à la fin des clips.
