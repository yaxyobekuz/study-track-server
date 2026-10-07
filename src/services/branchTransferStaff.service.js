/**
 * XODIMNI BOSHQA FILIALGA KO'CHIRISH — o'qituvchi, tyutor va boshqa barcha
 * xodimlar. Umumiy oqim va tranzaksiya — `branchTransfer.service.js`.
 *
 * IKKI REJIM:
 *   share — xodim shu filialda QOLADI, maqsad filial qo'shiladi (ikki va
 *           undan ko'p filialda ishlaydi). Uy filiali o'zgarmaydi.
 *   move  — maqsad filial UY filialiga aylanadi (login o'sha yerga tushadi).
 *           `keepSource` bo'lsa shu filialda ham ishlashda davom etadi, aks
 *           holda shu filialdan chiqadi (profil qatori qoladi — davomat,
 *           jarima, oylik tarixi unga ishora qiladi; `detachFromBranch` naqshi).
 *
 * ⚠️ OYLIK IKKI MARTA HISOBLANMAYDI (`payrollOwnership.service.js`):
 * asosiy oylik har oy uchun BITTA filialda. Ko'chirishda shu filial o'tgan
 * oylarini va ko'chish oyini MUHRLAYDI — ko'chish oyining asosiy oyligi shu
 * yerda (oy aniqligida, kun proratsiyasi yo'q — `finance.md` §10), keyingi
 * oydan yangi uy filialida. Boshqa filialda faqat u yerda o'tilgan dars va
 * tyutorlik hisoblanadi.
 *
 * KO'CHADI: login, parol, ism, telefon (AYNI `id`), profil rasmi, fanlar
 * (nomi bo'yicha mos kelganlari), ruxsatlar (tanlov bo'yicha), ish vaqti
 * (to'liq ko'chishda). KO'CHMAYDI: oylik sharti (lavozim, toifa — har
 * filialning o'z katalogi), davomat, jarima, topshiriq, oylik tarixi —
 * ular shu filial FAKTI.
 */

const { ROLES, WORK_TIME_SOURCE } = require("../utils/constants");
const { hasRole } = require("../utils/permissions");
const logger = require("../utils/logger");
const { runWithBranch } = require("../config/branchContext");
const { qualified, schemaType, copyRows } = require("../helpers/crossSchema.helpers");
const { nextMonth, formatMonthKey } = require("../helpers/month.helpers");
const { formatSum, sumAmounts } = require("../helpers/money.helpers");
const { pinMonths, SOURCES } = require("./payrollOwnership.service");
const { closeSessions } = require("./branchTransferStudent.service");

const OPEN_TASK_STATUSES = ["pending", "extended", "pending_rejected", "pending_review"];

/**
 * Yangi filialdagi ish vaqti: to'liq ko'chishda — o'zinikiday, aks holda
 * rolning standarti (`attachToBranch` bilan bir xil). "Dars jadvalidan"
 * manbai faqat o'qituvchida (`normalizeWorkTimeSource` qoidasi).
 */
const resolveWorkTime = ({ copy, user, role, roleRow }) => {
  const isTeacher = hasRole({ role, extraRoles: user.extraRoles ?? [] }, ROLES.TEACHER);
  if (copy) {
    return {
      source:
        user.workTimeSource === WORK_TIME_SOURCE.SCHEDULE && !isTeacher
          ? WORK_TIME_SOURCE.MANUAL
          : user.workTimeSource,
      startTime: user.workStartTime,
      endTime: user.workEndTime,
      days: user.workDays ?? [],
      weekly: user.weeklySchedule ?? {},
    };
  }
  return {
    source: WORK_TIME_SOURCE.MANUAL,
    startTime: roleRow?.workStartTime ?? null,
    endTime: roleRow?.workEndTime ?? null,
    days: roleRow?.workDays ?? [],
    weekly: roleRow?.weeklySchedule ?? {},
  };
};

/**
 * Xodimlar rejasi (oldindan ko'rish va tranzaksiya ichida — AYNI kod).
 *
 * @param {object} db
 * @param {object} ctx
 * @param {string[]} staffIds
 * @param {{mode: "share"|"move", keepSource: boolean, role: string|null, permissionsMode: "roleDefaults"|"copy"}} options
 */
const planStaff = async (db, ctx, staffIds, options) => {
  const ids = [...new Set(staffIds)].sort();
  const src = (t) => qualified(ctx.source.schemaName, t);
  const tgt = (t) => qualified(ctx.target.schemaName, t);
  const plat = (t) => qualified(ctx.platformSchema, t);
  const q = (sql, ...params) => db.$queryRawUnsafe(sql, ...params);
  const countBy = (rows, key = "staffId") => new Map(rows.map((r) => [String(r[key]), r]));
  const isMove = options.mode === "move";
  const leaving = isMove && !options.keepSource;

  const users = await q(
    `SELECT id, username, first_name AS "firstName", last_name AS "lastName", role,
            extra_roles AS "extraRoles", permissions, is_archived AS "isArchived",
            profile_picture AS "profilePicture", work_time_source::text AS "workTimeSource",
            work_start_time AS "workStartTime", work_end_time AS "workEndTime",
            work_days AS "workDays", weekly_schedule AS "weeklySchedule",
            position_id AS "positionId", salary_category_id AS "salaryCategoryId"
     FROM ${src("users")} WHERE id = ANY($1::text[]) ORDER BY id`,
    ids,
  );
  const directory = await q(
    `SELECT id, branch_id AS "branchId" FROM ${plat("user_directory")} WHERE id = ANY($1::text[])`,
    ids,
  );
  const access = await q(
    `SELECT user_id AS "userId", branch_id AS "branchId", is_home AS "isHome"
     FROM ${plat("user_branch_access")} WHERE user_id = ANY($1::text[])`,
    ids,
  );
  const targetRows = await q(
    `SELECT id, position_id AS "positionId", salary_category_id AS "salaryCategoryId"
     FROM ${tgt("users")} WHERE id = ANY($1::text[])`,
    ids,
  );
  const usernameClashes = await q(
    `SELECT username FROM ${tgt("users")}
     WHERE username = ANY($1::text[]) AND NOT (id = ANY($2::text[]))`,
    users.map((u) => u.username),
    ids,
  );
  const roleValues = [...new Set([...(options.role ? [options.role] : []), ...users.map((u) => u.role)])];
  const roles = await q(
    `SELECT value, name, permissions, work_start_time AS "workStartTime", work_end_time AS "workEndTime",
            work_days AS "workDays", weekly_schedule AS "weeklySchedule"
     FROM ${plat("roles")} WHERE value = ANY($1::text[])`,
    roleValues,
  );

  const lessons = await q(
    `SELECT sl.teacher_id AS "staffId", COUNT(*)::int AS n FROM ${src("schedule_lessons")} sl
     WHERE sl.teacher_id = ANY($1::text[]) GROUP BY sl.teacher_id`,
    ids,
  );
  const tutorGroups = await q(
    `SELECT tg.id, tg.tutor_id AS "staffId", c.name AS "className" FROM ${src("tutor_groups")} tg
     JOIN ${src("classes")} c ON c.id = tg.class_id
     WHERE tg.tutor_id = ANY($1::text[]) AND (tg.end_month IS NULL OR tg.end_month >= $2)
     ORDER BY c.name`,
    ids,
    ctx.month,
  );
  const substitutions = await q(
    `SELECT u AS "staffId", COUNT(*)::int AS n FROM (
       SELECT original_teacher_id AS u FROM ${src("lesson_substitutions")}
         WHERE status = 'active' AND to_date >= $2::date AND original_teacher_id = ANY($1::text[])
       UNION ALL
       SELECT substitute_teacher_id FROM ${src("lesson_substitutions")}
         WHERE status = 'active' AND to_date >= $2::date AND substitute_teacher_id = ANY($1::text[])
     ) x GROUP BY u`,
    ids,
    ctx.todayIso,
  );
  const tasks = await q(
    `SELECT assignee AS "staffId", COUNT(*)::int AS n FROM ${src("tasks")}
     WHERE assignee = ANY($1::text[]) AND status::text = ANY($2::text[]) GROUP BY assignee`,
    ids,
    OPEN_TASK_STATUSES,
  );
  const rooms = await q(
    `SELECT responsible_id AS "staffId", COUNT(*)::int AS n FROM ${src("inventory_locations")}
     WHERE responsible_id = ANY($1::text[]) AND is_archived = false GROUP BY responsible_id`,
    ids,
  );
  const clubs = await q(
    `SELECT teacher_id AS "staffId", COUNT(*)::int AS n FROM ${src("clubs")}
     WHERE teacher_id = ANY($1::text[]) AND is_active = true GROUP BY teacher_id`,
    ids,
  );
  const unpaid = await q(
    `SELECT staff_id AS "staffId", month, (amount - paid_amount)::text AS due
     FROM ${src("payroll_entries")}
     WHERE staff_id = ANY($1::text[]) AND status IN ('unpaid', 'partial')
     ORDER BY month`,
    ids,
  );
  // Asosiy oyligi shu filialda hisoblangan oylar — muhrlanadi
  const fixedMonths = await q(
    `SELECT staff_id AS "staffId", month FROM ${src("payroll_entries")}
     WHERE staff_id = ANY($1::text[]) AND status <> 'cancelled' AND fixed_amount > 0`,
    ids,
  );
  const fixedRules = await q(
    `SELECT DISTINCT staff_id AS "staffId" FROM ${src("staff_salaries")}
     WHERE staff_id = ANY($1::text[]) AND fixed_amount > 0
       AND start_month <= $2 AND (end_month IS NULL OR end_month >= $2)`,
    ids,
    ctx.month,
  );
  const subjects = await q(
    `SELECT us.user_id AS "staffId", ss.name, ts.id AS "targetId"
     FROM ${src("user_subjects")} us
     JOIN ${src("subjects")} ss ON ss.id = us.subject_id
     LEFT JOIN ${tgt("subjects")} ts ON lower(ts.name) = lower(ss.name)
     WHERE us.user_id = ANY($1::text[]) ORDER BY ss.name`,
    ids,
  );

  const userById = new Map(users.map((u) => [u.id, u]));
  const homeOf = new Map(directory.map((d) => [d.id, d.branchId]));
  const accessOf = new Map();
  for (const row of access) {
    if (!accessOf.has(row.userId)) accessOf.set(row.userId, []);
    accessOf.get(row.userId).push(row.branchId);
  }
  const targetRowOf = new Map(targetRows.map((r) => [r.id, r]));
  const clashes = new Set(usernameClashes.map((r) => r.username));
  const roleOf = new Map(roles.map((r) => [r.value, r]));
  const lessonsOf = countBy(lessons);
  const substitutionsOf = countBy(substitutions);
  const tasksOf = countBy(tasks);
  const roomsOf = countBy(rooms);
  const clubsOf = countBy(clubs);
  const fixedRuleSet = new Set(fixedRules.map((r) => r.staffId));
  const groupBy = (rows) => {
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.staffId)) map.set(row.staffId, []);
      map.get(row.staffId).push(row);
    }
    return map;
  };
  const tutorOf = groupBy(tutorGroups);
  const unpaidOf = groupBy(unpaid);
  const fixedMonthsOf = groupBy(fixedMonths);
  const subjectsOf = groupBy(subjects);

  const items = [];
  for (const id of ids) {
    const user = userById.get(id);
    const blockers = [];
    const warnings = [];
    const notes = [];

    if (!user) {
      items.push({ id, label: "Noma'lum", status: "blocked", blockers: ["Bu filialda bunday xodim topilmadi"], warnings, notes });
      continue;
    }
    const label = `${user.firstName} ${user.lastName ?? ""}`.trim();
    const branches = accessOf.get(id) ?? [];
    const home = homeOf.get(id) ?? ctx.source.id;

    if (user.role === ROLES.STUDENT) blockers.push("Bu o'quvchi — o'quvchilar alohida ko'chiriladi");
    if (user.role === ROLES.OWNER) blockers.push("Tizim egasi barcha filiallarda avtomatik bor");
    if (user.isArchived) blockers.push("Xodim arxivlangan");
    if (homeOf.has(id) && !branches.includes(ctx.source.id)) {
      blockers.push("Xodim bu filialdan chiqarilgan — u amaldagi filialidan ko'chiriladi");
    }
    if (!isMove && branches.includes(ctx.target.id)) {
      blockers.push(`Xodim "${ctx.target.name}" filialiga allaqachon biriktirilgan`);
    }
    if (isMove && home !== ctx.source.id) {
      blockers.push("Xodimni faqat asosiy (uy) filialidan ko'chirish mumkin");
    }
    if (clashes.has(user.username)) {
      blockers.push(
        `"${ctx.target.name}" filialida "${user.username}" logini bilan boshqa (eski) yozuv bor`,
      );
    }

    const targetRole = options.role || user.role;
    const roleRow = roleOf.get(targetRole);
    if (!roleRow) blockers.push(`"${targetRole}" roli topilmadi`);
    if (targetRole === ROLES.STUDENT || targetRole === ROLES.OWNER) {
      blockers.push("Xodimga bu rolni berib bo'lmaydi");
    }

    const copyPermissions = options.permissionsMode === "copy";
    const permissions = copyPermissions ? user.permissions ?? [] : roleRow?.permissions ?? [];
    const extraRoles = copyPermissions ? user.extraRoles ?? [] : [];
    const workTime = resolveWorkTime({ copy: isMove, user, role: targetRole, roleRow });

    // ── Oylik ──
    const hasFixedHere = Boolean(user.positionId) || fixedRuleSet.has(id);
    const pinRows = (fixedMonthsOf.get(id) ?? []).map((r) => r.month);
    if (isMove && hasFixedHere) pinRows.push(ctx.month);
    const targetRow = targetRowOf.get(id);

    if (isMove) {
      notes.push(
        hasFixedHere
          ? `${formatMonthKey(ctx.month)} oyining asosiy oyligi shu filialda hisoblanadi, ` +
              `${formatMonthKey(nextMonth(ctx.month))} dan — "${ctx.target.name}" filialida`
          : `Asosiy oylik ${formatMonthKey(ctx.month)} dan "${ctx.target.name}" filialida belgilanadi`,
      );
      if (targetRow?.positionId || targetRow?.salaryCategoryId) {
        notes.push(`"${ctx.target.name}" filialida avvalgi oylik sharti bor — u yana amal qiladi`);
      } else {
        warnings.push(`Oylik sharti (lavozim yoki toifa) "${ctx.target.name}" filialida belgilanadi`);
      }
    } else {
      notes.push(
        "Asosiy oylik avvalgidek bitta filialda qoladi; " +
          `"${ctx.target.name}" filialida faqat u yerda o'tilgan dars va tyutorlik hisoblanadi`,
      );
      if (workTime.source === WORK_TIME_SOURCE.MANUAL) {
        warnings.push(
          `Ish kunlari har filialda alohida — "${ctx.target.name}" filialida faqat u yerda ishlaydigan ` +
            "kunlarni belgilang, aks holda boshqa kunlar \"kelmadi\" bo'lib yoziladi",
        );
      }
    }

    const due = unpaidOf.get(id) ?? [];
    if (due.length) {
      notes.push(
        `Shu filialda to'lanmagan oylik: ${formatSum(sumAmounts(due.map((r) => r.due)))} ` +
          `(${due.map((r) => formatMonthKey(r.month)).join(", ")}) — u shu filial kassasidan to'lanadi`,
      );
    }

    // ── Shu filialdagi ishlar (faqat butunlay chiqib ketsa) ──
    const groups = tutorOf.get(id) ?? [];
    if (leaving) {
      const lessonCount = lessonsOf.get(id)?.n ?? 0;
      if (lessonCount) {
        warnings.push(`Shu filial dars jadvalida ${lessonCount} ta darsi bor — boshqa o'qituvchiga bering`);
      }
      if (groups.length) {
        warnings.push(
          `Tyutor guruhlari (${groups.map((g) => g.className).join(", ")}) ` +
            `${formatMonthKey(ctx.month)} oxirida yopiladi`,
        );
      }
      const subs = substitutionsOf.get(id)?.n ?? 0;
      if (subs) warnings.push(`${subs} ta amaldagi o'rinbosarlik bor — ularni qayta ko'rib chiqing`);
      const openTasks = tasksOf.get(id)?.n ?? 0;
      if (openTasks) warnings.push(`${openTasks} ta bajarilmagan topshirig'i bor`);
      const roomCount = roomsOf.get(id)?.n ?? 0;
      if (roomCount) warnings.push(`${roomCount} ta xonaga mas'ul — inventar mas'ulini almashtiring`);
      const clubCount = clubsOf.get(id)?.n ?? 0;
      if (clubCount) warnings.push(`${clubCount} ta to'garak rahbari`);
    }

    const subjectRows = subjectsOf.get(id) ?? [];
    const matched = subjectRows.filter((r) => r.targetId);
    const unmatched = subjectRows.filter((r) => !r.targetId);
    if (matched.length) notes.push(`Fanlar: ${matched.map((r) => r.name).join(", ")}`);
    if (unmatched.length) {
      warnings.push(`"${ctx.target.name}" filialida yo'q fanlar biriktirilmaydi: ${unmatched.map((r) => r.name).join(", ")}`);
    }

    items.push({
      id,
      label,
      username: user.username,
      role: user.role,
      status: blockers.length ? "blocked" : "ready",
      blockers,
      warnings,
      notes,
      plan: {
        targetRole,
        permissions: [...permissions].sort(),
        extraRoles: [...extraRoles].sort(),
        workTime,
        subjectIds: matched.map((r) => r.targetId),
        pinMonths: [...new Set(pinRows)].sort((a, b) => a - b),
        tutorGroupIds: leaving ? groups.map((g) => g.id) : [],
        profilePicture: user.profilePicture ?? null,
        returning: Boolean(targetRow),
        isHomeBefore: home === ctx.source.id,
      },
    });
  }

  const ready = items.filter((item) => item.status === "ready");
  const acknowledgements = [
    {
      code: "history_stays",
      title: "Tarix shu filialda qoladi",
      message:
        "Davomat, jarima, topshiriq va oylik tarixi shu filial fakti bo'lib qoladi. " +
        "Oylik sharti (lavozim, toifa) har filialning o'z katalogi — yangi filialda alohida belgilanadi.",
    },
    {
      code: "payroll_single",
      title: "Asosiy oylik — bitta filialda",
      message:
        "Asosiy oylik (lavozim maoshi, fiksa, ustamalar) har oy faqat BITTA filialda hisoblanadi va " +
        "to'lanadi — ikkinchi filialda u nol bo'ladi. Dars soati va tyutorlik esa qaysi filialda " +
        "o'tilgan bo'lsa, o'sha filialda hisoblanadi. Ikki marta to'lash imkonsiz.",
    },
  ];
  if (leaving && ready.some((item) => item.warnings.length)) {
    acknowledgements.push({
      code: "work_reassign",
      title: "Shu filialdagi ishlarni qayta taqsimlash kerak",
      message:
        "Xodim shu filialdan chiqadi: uning darslari, o'rinbosarliklari, topshiriqlari va xonalari " +
        "boshqa xodimga berilishi kerak. Tyutor guruhlari oy oxirida avtomatik yopiladi.",
    });
  }

  return { items, acknowledgements };
};

/**
 * Rejani tranzaksiyada yozadi.
 * @returns {Promise<Map<string, object>>}
 */
const writeStaff = async (db, ctx, items, options) => {
  const from = ctx.source.schemaName;
  const to = ctx.target.schemaName;
  const src = (t) => qualified(from, t);
  const tgt = (t) => qualified(to, t);
  const plat = (t) => qualified(ctx.platformSchema, t);
  const exec = (sql, ...params) => db.$executeRawUnsafe(sql, ...params);
  const isMove = options.mode === "move";
  const leaving = isMove && !options.keepSource;
  const moved = new Map();

  const pictureIds = [...new Set(items.map((i) => i.plan.profilePicture).filter(Boolean))];
  if (pictureIds.length) {
    await copyRows(db, ctx.cache, {
      from,
      to,
      table: "images",
      where: `s."id" = ANY($1::text[])`,
      params: [pictureIds],
      onConflict: "nothing",
    });
  }

  for (const item of items) {
    const { plan } = item;

    // Profil — AYNI id. Qaytib kelgan xodimning shu filialdagi oylik sharti
    // va jarima/tanga holati SAQLANADI (`keepOnUpdate`), yangisida bo'sh.
    await copyRows(db, ctx.cache, {
      from,
      to,
      table: "users",
      where: `s."id" = $1`,
      params: [
        item.id,
        plan.targetRole,
        plan.permissions,
        plan.extraRoles,
        plan.workTime.source,
        plan.workTime.startTime,
        plan.workTime.endTime,
        plan.workTime.days,
        JSON.stringify(plan.workTime.weekly ?? {}),
      ],
      override: {
        role: "$2",
        permissions: "$3::text[]",
        extra_roles: "$4::text[]",
        work_time_source: `$5::text::${schemaType(to, "WorkTimeSource")}`,
        work_start_time: "$6::text",
        work_end_time: "$7::text",
        work_days: "$8::int[]",
        weekly_schedule: "$9::jsonb",
        is_archived: "false",
        archived_at: "NULL",
        archive_snapshot: "NULL",
        archive_note: "NULL",
        position_id: "NULL",
        salary_category_id: "NULL",
        custom_base_salary: "NULL",
        coin_balance: "0",
        penalty_points: "0",
        updated_at: "NOW()",
      },
      onConflict: "update",
      keepOnUpdate: [
        "position_id",
        "salary_category_id",
        "custom_base_salary",
        "coin_balance",
        "penalty_points",
        "created_at",
      ],
    });

    if (plan.subjectIds.length) {
      await exec(
        `INSERT INTO ${tgt("user_subjects")} (user_id, subject_id)
         SELECT $1, sid FROM unnest($2::text[]) AS t(sid) ON CONFLICT DO NOTHING`,
        item.id,
        plan.subjectIds,
      );
    }

    if (isMove) {
      await exec(
        `UPDATE ${plat("user_directory")} SET branch_id = $2, role = $3, updated_at = NOW() WHERE id = $1`,
        item.id,
        ctx.target.id,
        plan.targetRole,
      );
      await exec(
        `UPDATE ${plat("user_branch_access")} SET is_home = false, updated_at = NOW()
         WHERE user_id = $1 AND branch_id <> $2`,
        item.id,
        ctx.target.id,
      );
    }
    await exec(
      `INSERT INTO ${plat("user_branch_access")}
         (user_id, branch_id, role, is_home, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (user_id, branch_id)
       DO UPDATE SET role = EXCLUDED.role, is_home = EXCLUDED.is_home, updated_at = NOW()`,
      item.id,
      ctx.target.id,
      plan.targetRole,
      isMove,
      ctx.actor.id,
    );

    if (leaving) {
      await exec(
        `DELETE FROM ${plat("user_branch_access")} WHERE user_id = $1 AND branch_id = $2`,
        item.id,
        ctx.source.id,
      );
      // `detachFromBranch` bilan AYNI: qator qoladi, kirish yopiladi, ruxsat va
      // qo'shimcha rollar tozalanadi (qaytsa eskisi tirilib qolmasin)
      await exec(
        `UPDATE ${src("users")} SET is_active = false, permissions = '{}', extra_roles = '{}',
           updated_at = NOW() WHERE id = $1`,
        item.id,
      );
    }

    if (plan.pinMonths.length) {
      await pinMonths(db, {
        rows: plan.pinMonths.map((month) => ({ userId: item.id, month })),
        branchId: ctx.source.id,
        source: SOURCES.TRANSFER,
      });
    }

    moved.set(item.id, {
      role: plan.targetRole,
      permissions: plan.permissions.length,
      subjects: plan.subjectIds.length,
      payrollMonthsPinned: plan.pinMonths,
      leftSource: leaving,
      homeChanged: isMove,
    });
  }

  return moved;
};

/**
 * Tranzaksiyadan keyin: shu filialdan butunlay chiqqan xodimning tyutor
 * guruhlari "keyingi oydan" yopiladi (ko'chish oyi shu yerda hisoblanadi —
 * `tutorGroup.removeGroup`), seanslari yopiladi.
 *
 * @returns {Promise<Map<string, string[]>>}
 */
const afterStaff = async (ctx, items, options) => {
  const warnings = new Map(items.map((item) => [item.id, []]));
  const leaving = options.mode === "move" && !options.keepSource;
  if (!leaving) return warnings;

  await runWithBranch(ctx.source, async () => {
    const { removeGroup } = require("./tutorGroup.service");
    for (const item of items) {
      for (const groupId of item.plan.tutorGroupIds) {
        try {
          await removeGroup(groupId, { effective: "next" }, ctx.actor.id);
        } catch (error) {
          warnings.get(item.id).push(`Tyutor guruhi yopilmadi — qo'lda yoping (${error.message})`);
          logger.warn(`[branchTransfer] tyutor guruhi ${groupId} yopilmadi: ${error.message}`);
        }
      }
    }
  });

  await closeSessions(items.map((item) => item.id), ctx.source.id);
  return warnings;
};

module.exports = {
  planStaff,
  writeStaff,
  afterStaff,
  resolveWorkTime,
};
