# Submission checklist

What's left before the 11 Nov deadline, all of which only you can do.

## Before you push

**Take the Clash Display font files out of the unpushed commits.** Its licence forbids making the files available to others through a repository, and these commits haven't been pushed, so nothing has left your machine yet. Run this from the repo folder in Git Bash, with a clean working tree:

```bash
git branch backup-before-font-removal
mkdir -p ../font-backup && cp apps/web/public/fonts/ClashDisplay-*.woff2 ../font-backup/
git filter-branch -f --index-filter \
  'git rm -q --cached --ignore-unmatch apps/web/public/fonts/ClashDisplay-Medium.woff2 apps/web/public/fonts/ClashDisplay-Semibold.woff2 apps/web/public/fonts/ClashDisplay-Bold.woff2' \
  origin/main..HEAD
printf '\n# Clash Display: get your own copy from fontshare.com, its licence forbids sharing the files.\napps/web/public/fonts/*.woff2\n' >> .gitignore
cp ../font-backup/*.woff2 apps/web/public/fonts/
git add .gitignore && git commit -m "chore: keep the Clash Display font files out of git"
git log origin/main..HEAD --name-only --format= | grep -c woff2
```

The last line should print `0`. The app on your machine looks the same, because the files are back in place and ignored. Stop your dev server first, as Windows may refuse to change files it has open.

Once it's pushed and you're happy, delete the backup with `git branch -D backup-before-font-removal`, because that branch still holds the font files. Don't push that branch.

**Stray files.** These aren't committed, because they aren't part of this work:

- `DESIGN.md` and `getpaid-stamp-gold-clean.svg` at the root are identical copies of `docs/DESIGN.md` and the app's logo source, and are safe to delete.
- `promo/` (a screenshot script and its images) appeared while this was being prepared. While it's in the repo folder, `npm run check` fails on lint, because the script doesn't follow the repo's lint rules. Move it out of the repo folder, or add `promo/**` to the ignores in `eslint.config.mjs`. Check its images for real client data before you commit any.

## Before you submit

- [ ] **Copyright name.** `LICENSE` says `dharmik-o`. Change it if you'd like your full name there.
- [ ] **Repo access.** Check that the repo is public, or shared the way the hackathon's rules ask, and that the clone address in the README still works.
- [ ] **Try the README on a clean machine or a fresh folder.** Its steps come from the code and the docs here, and haven't been run from scratch. That goes especially for step 7, the n8n import.
- [ ] **Run `docs/DEMO.md` live, once.** It hasn't been run as one piece.
- [ ] **Do the checks still open in `docs/NEEDS_YOU.md`:** at least a paid invoice through its webhook, since the video depends on it.
- [ ] **Run Test connection with Claude,** since the Devpost text and video name it. If you won't use it, change both to the model you did use.
- [ ] **Real reauthorize, on or after 9 Nov.** The command is in `docs/NEEDS_YOU.md`. The Devpost text says "reauthorize after day 3", which is built, but has only run with PayPal mocked until then.
- [ ] **Record the video** from `docs/VIDEO-SCRIPT.md`, and add its link.
- [ ] **Read `docs/SUBMISSION.md`.** Add your own story to Inspiration, and check the "we" wording fits your team. If the live checks above fail, take out whatever it claims about them.
