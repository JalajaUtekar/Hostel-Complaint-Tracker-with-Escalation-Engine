/**
 * ResolveX — one-off, IDEMPOTENT migration.
 *
 * Re-routes escalation records that were created under the OLD behaviour
 * (URGENT complaints auto-escalated to Admin) so that EVERY automatic
 * escalation is owned by the Warden instead.
 *
 * What it touches — and nothing else:
 *   1. Escalation docs with toRole === 'admin'      -> toRole = 'warden'
 *   2. Complaint docs that are still escalated with
 *      currentAuthorityRole === 'admin'             -> currentAuthority = <warden>,
 *                                                      currentAuthorityRole = 'warden'
 *   3. complaint_escalated notifications addressed
 *      to the admin for those complaints            -> userId = <warden>
 *
 * It never deletes complaints, never reseeds, never wipes anything, never
 * reads or prints .env secrets. Safe to run multiple times — a second run
 * finds nothing to do.
 *
 * Run:  node scripts/fixEscalationAuthority.js
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const Complaint = require('../models/Complaint');
const Escalation = require('../models/Escalation');
const Notification = require('../models/Notification');
const User = require('../models/User');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected (db: ${mongoose.connection.name})`);

  // Deterministic warden lookup — same rule escalationService uses.
  const warden = await User.findOne({ role: 'warden', isActive: true })
    .sort({ createdAt: 1, _id: 1 })
    .select('_id name');
  if (!warden) {
    console.error('No active warden user found — cannot migrate. Aborting (nothing changed).');
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`Target warden: ${warden.name} (${warden._id})`);

  // 1. Escalation records misrouted to admin.
  const misroutedEsc = await Escalation.find({ toRole: 'admin' }).select('_id complaintId').lean();
  const affectedComplaintIds = [...new Set(misroutedEsc.map((e) => String(e.complaintId)))];
  const escRes = await Escalation.updateMany({ toRole: 'admin' }, { $set: { toRole: 'warden' } });
  console.log(`Escalation records re-pointed admin -> warden: ${escRes.modifiedCount}`);

  // 2. Complaints still carrying an admin authority from an automatic escalation.
  const cmpRes = await Complaint.updateMany(
    { isEscalated: true, currentAuthorityRole: 'admin' },
    { $set: { currentAuthority: warden._id, currentAuthorityRole: 'warden' } }
  );
  console.log(`Complaints re-pointed to warden authority: ${cmpRes.modifiedCount}`);

  // 3. Escalation notifications for those complaints that landed on an admin.
  let notifMoved = 0;
  if (affectedComplaintIds.length) {
    const admins = await User.find({ role: 'admin' }).select('_id').lean();
    const adminIds = admins.map((a) => a._id);
    const complaintObjIds = affectedComplaintIds.map((id) => new mongoose.Types.ObjectId(id));

    const notifs = await Notification.find({
      type: 'complaint_escalated',
      relatedId: { $in: complaintObjIds },
      userId: { $in: adminIds },
    });

    for (const n of notifs) {
      // Respect idempotency of notifyEscalation: (userId + type + relatedId) is
      // the natural key. If the warden already has one for this complaint,
      // delete the stale admin copy instead of creating a duplicate.
      const existing = await Notification.findOne({
        userId: warden._id,
        type: 'complaint_escalated',
        relatedId: n.relatedId,
      });
      if (existing) {
        await Notification.deleteOne({ _id: n._id });
      } else {
        n.userId = warden._id;
        n.message = n.message.replace(/escalated to you as admin\.?$/i, 'escalated to you as warden.');
        await n.save();
        notifMoved += 1;
      }
    }
  }
  console.log(`Escalation notifications moved admin -> warden: ${notifMoved}`);

  // 4. Cosmetic data fix: the demo admin account was seeded with the misleading
  //    display name "Admin Warden", which surfaces in the Admin dashboard UI.
  //    Only touch that exact legacy string on the admin account.
  const nameRes = await User.updateMany(
    { role: 'admin', name: 'Admin Warden' },
    { $set: { name: 'Admin' } }
  );
  console.log(`Admin display name "Admin Warden" -> "Admin": ${nameRes.modifiedCount}`);

  console.log('\nMigration complete.');
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error('FATAL', err);
  try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
  process.exit(1);
});
