import json, os
R='/home/ubuntu/gfv-scratch/carton/ux-qa/rig/'; Q='/home/ubuntu/gfv-scratch/carton/ux-qa/qa/'; M='/home/ubuntu/gfv-scratch/carton/ux-redesign/after/'
U='/home/ubuntu/.t3/userdata/attachments/34ab41b4-a742-4531-9258-277aa461340b-'
pairs=[]
def p(name, *items, scale=0.5):
    pairs.append({"name":name,"items":[list(i) for i in items],"scale":scale})
B=lambda f:("Build (React)",f); BP=lambda f:("Build (Preact)",f); MK=lambda f:("Mockup",M+f)
# History
for s,w in [("default",384),("default",300),("expanded",384),("expanded",300),("older",384),("older",300),("restore",384),("restore",300),("viewing",384),("viewing",300),("empty",384),("empty",300)]:
    p(f"history-{s}-{w}", B(R+f"after-history-{s}-{w}.png"), MK(f"history-{s}-{w}.png"))
for s in ["menu","filter","clip","many","working","offline","loading","newcut"]:
    p(f"history-{s}-384", B(R+f"after-history-{s}-384.png"), MK(f"history-{s}-384.png"))
p("history-group-open-384", B(Q+"history-group-open-384.png"), B(Q+"history-group-open-300.png"))
p("history-filter-on", B(Q+"history-filter-on-384.png"), B(Q+"history-filter-on-300.png"), MK("history-filter-384.png"))
p("history-errors", B(Q+"history-restore-error-384.png"), B(Q+"history-undo-turn-error-384.png"), B(Q+"history-play-fail-384.png"))
p("history-keyboard", B(Q+"history-keyboard-384.png"), B(Q+"history-keyboard-card-384.png"), B(Q+"history-name-384.png"))
p("history-more", B(Q+"history-card-more-384.png"), B(Q+"history-start-row-384.png"), B(Q+"history-fold-row-menu-384.png"), B(Q+"history-offline-menu-384.png"))
p("history-teammate-cut-384", B(R+"ws6-teammate-cut-384.png"), MK("history-teammate-cut-384.png"))
# Changes
for s,w,m in [("",384,"changes-384.png"),("",300,"changes-300.png"),("-playing",384,"changes-playing-384.png"),("-none",384,"changes-none-384.png")]:
    p(f"changes{s}-{w}", B(R+f"changes{s}-{w}.png"), MK(m))
p("changes-before-two", B(R+"changes-before-384.png"), B(R+"changes-two-384.png"), B(Q+"changes-play-older-384.png"))
p("user-watch-the-changes", ("User's screenshot (before)", U+"4c68ce4c-9b90-4002-ad3c-ba83b0c75b12.png"), B(R+"changes-playing-384.png"), scale=0.5)
p("user-read-only-banner", ("User's screenshot (before)", U+"0f70ac1e-6631-45f8-849a-e2a31273005c.png"), B(Q+"titlebar-viewing.png"), scale=0.5)
# Cuts and fold
for w in [384,300]:
    p(f"cuts-menu-{w}", B(R+f"ws6-cuts-menu-{w}.png"), MK(f"cuts-menu-{w}.png"))
    p(f"cuts-menu-turn-{w}", B(R+f"ws6-cuts-menu-turn-{w}.png"), MK(f"cuts-menu-turn-{w}.png"))
p("cuts-more", B(R+"ws6-cuts-queued-384.png"), B(R+"ws6-cuts-many-384.png"), B(R+"ws6-cuts-new-384.png"), B(Q+"cuts-one-384.png"))
for s,m in [("all","fold-all.png"),("some","fold-some.png"),("conflict-unpicked","fold-conflict.png"),("rest","fold-rest.png"),("nothing","fold-nothing.png")]:
    p(f"fold-{s}", B(R+f"ws6-fold-{s}.png"), MK(m))
p("fold-into-picked", B(R+"ws6-fold-into.png"), B(R+"ws6-fold-conflict.png"))
p("fold-from-teammate", B(Q+"teammate-fold-384.png"), scale=0.35)
# Conflicts
for s,m in [("card","conflict-card.png"),("both","conflict-keep-both.png"),("twice","conflict-same-person.png"),("turn","conflict-during-turn.png"),("pill","conflict-pill.png")]:
    p(f"conflict-{s}", B(Q+f"conflict-{s}.png"), MK(m))
p("conflict-more", B(Q+"conflict-picked.png"), B(Q+"conflict-theirs.png"), B(Q+"conflict-again.png"), B(Q+"conflict-focus.png"))
p("conflict-old-narrow", B(Q+"conflict-old-words.png"), B(Q+"conflict-narrow.png"))
# Editor compositions
for s in ["default","viewing","before","edit-attempt","conflict-theirs","conflict-pill","other-cut"]:
    p(f"editor-{s}", B(Q+f"editor-{s}.png"), MK(f"editor-{s}.png"), scale=0.3)
p("editor-toast-offline", B(R+"after-toast-offline.png"), MK("editor-toast-offline.png"), scale=0.3)
for s in ["play-newest","export-viewing","teammate-cut","chip-menu","comments-see","shared","narrow-1100","960"]:
    p(f"editor-{s}", B(Q+f"editor-{s}.png"), scale=0.4)
p("editor-live-media", B(Q+"live-media.png"), MK("stage-live-media.png"))
# Title bar
for s,m in [("default","titlebar-default.png"),("other-cut","titlebar-other-cut.png"),("viewing","titlebar-viewing.png"),("teammate","titlebar-teammate-cut.png"),("shared","titlebar-shared.png"),("offline","titlebar-offline.png"),("1100","titlebar-narrow.png")]:
    pairs.append({"name":f"titlebar-{s}","items":[["Build (React)",Q+f"titlebar-{s}.png"],["Mockup",M+m]],"scale":0.5,"col":True})
p("titlebar-960", B(Q+"titlebar-960-main.png"), B(Q+"titlebar-960-other.png"), B(Q+"titlebar-960-viewing.png"), B(Q+"titlebar-960-long-viewing.png"), scale=0.5)
p("titlebar-before-conflict", B(Q+"titlebar-before.png"), B(Q+"titlebar-conflict-see.png"))
# Toasts
p("toasts", B(R+"after-toast-restore.png"), B(R+"after-toast-undone.png"), B(R+"after-toast-fold.png"), B(R+"after-toast-newcut.png"), scale=0.3)
p("toasts-2", B(R+"after-toast-turn.png"), B(R+"after-toast-pick.png"), B(R+"after-toast-switch.png"), B(Q+"toast-warning.png"), scale=0.3)
p("toasts-mockup", MK("toasts.png"))
# Share, join, comments
for s,m in [("first","share-first.png"),("owner","share-owner.png"),("offline","share-offline.png"),("unreachable","share-unreachable.png")]:
    p(f"share-{s}", B(Q+f"share-{s}.png"), MK(m))
p("share-more", B(Q+"share-first-empty.png"), B(Q+"share-submitted.png"), B(Q+"share-known.png"), B(Q+"share-code.png"))
p("share-more-2", B(Q+"share-owner-link.png"), B(Q+"share-editor.png"), B(Q+"share-update.png"))
p("join", B(Q+"join.png"), MK("join-dialog.png"), scale=0.4)
p("join-more", B(Q+"join-errors.png"), B(Q+"join-filled.png"), scale=0.4)
for w in [384,300]:
    p(f"comments-{w}", B(R+f"after-comments-{w}.png"), MK(f"comments-{w}.png"))
json.dump(pairs, open('/home/ubuntu/gfv-scratch/carton/ux-qa/rig-qa/pairs.json','w'), indent=1)
missing=[f for x in pairs for _,f in x["items"] if not os.path.exists(f)]
print(len(pairs),"pairs;", len(missing),"missing files"); print("\n".join(missing))
