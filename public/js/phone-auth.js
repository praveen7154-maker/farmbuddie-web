import { doc, setDoc, getDoc } 
from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

/* ================= NORMALIZE ================= */
export function normalizePhone(phone){
  return String(phone || "").replace(/\D/g,"").slice(-10);
}

/* ================= EXTRACT ================= */
export function extractPhones(data){

  const phones = [];

  if(data.primaryMobile){
    phones.push(normalizePhone(data.primaryMobile));
  }

  if(Array.isArray(data.appUsers)){
    data.appUsers.forEach(u=>{
      if(u.mobile){
        phones.push(normalizePhone(u.mobile));
      }
    });
  }

  return [...new Set(phones)];
}


/* ================= VALIDATE ONLY (NO SAVE) ================= */
export async function validatePhones(db, farmerData){

  const phones = extractPhones(farmerData);
  const identityId = farmerData.identityId || farmerData.aadhaarNumber;

  for(const phone of phones){

    if(!phone || phone.length !== 10) continue;

    const snap = await getDoc(doc(db,"phoneIndex",phone));

    if(snap.exists()){
      const existing = snap.data();

      // ❗ prevent same phone used by different identity
      if (existing.identityId && existing.identityId !== identityId) {
        throw new Error(`Phone ${phone} already used by another farmer`);
      }
    }
  }
}


/* ================= FULL SYNC ================= */
export async function fullPhoneSync(db, auth, farmerId, farmerData){

  const phones = extractPhones(farmerData);
  const identityId = farmerData.identityId || farmerData.aadhaarNumber;

  /* ===== SAVE LOGIN INDEX (PHONE → IDENTITY) ===== */
  for(const phone of phones){

    if(!phone || phone.length !== 10) continue;

    const phoneRef = doc(db,"phoneIndex",phone);
    const phoneSnap = await getDoc(phoneRef);

    if (phoneSnap.exists()) {

      const existing = phoneSnap.data();

      // ✅ backward fix (old records)
      if (!existing.identityId) {
        await setDoc(phoneRef, {
          ...existing,
          identityId
        }, { merge: true });
      }

      // ❗ prevent cross farmer conflict
      if (existing.identityId && existing.identityId !== identityId) {
        throw new Error(`Phone ${phone} already used by another farmer`);
      }
    }

    // ✅ FINAL WRITE (clean structure)
    await setDoc(phoneRef,{
      identityId,
      enabled: true,
      updatedAt:new Date(),
      updatedBy:auth.currentUser.uid
    },{ merge:true });

  }
}