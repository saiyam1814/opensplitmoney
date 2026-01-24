import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { 
  collection, 
  doc, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  query, 
  where, 
  onSnapshot,
  arrayUnion,
  arrayRemove,
  getDoc,
  getDocs
} from 'firebase/firestore';
import { db } from '../firebase/config';
import { useAuth } from './AuthContext';

const TripContext = createContext();

export function useTrips() {
  return useContext(TripContext);
}

// Generate a random invite code
function generateInviteCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

export function TripProvider({ children }) {
  const { user } = useAuth();
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);

  // Listen to user's trips
  useEffect(() => {
    if (!user) {
      setTrips([]);
      setLoading(false);
      return;
    }

    const q = query(
      collection(db, 'trips'),
      where('memberIds', 'array-contains', user.uid)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const tripsData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setTrips(tripsData.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
      setLoading(false);
    });

    return unsubscribe;
  }, [user]);

  // Create a new trip
  const createTrip = useCallback(async (tripData) => {
    if (!user) return { success: false, error: 'Not authenticated' };

    try {
      const inviteCode = generateInviteCode();
      const trip = {
        ...tripData,
        inviteCode,
        createdBy: user.uid,
        memberIds: [user.uid],
        members: [{
          uid: user.uid,
          email: user.email,
          displayName: user.displayName || user.email?.split('@')[0],
          photoURL: user.photoURL
        }],
        expenses: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const docRef = await addDoc(collection(db, 'trips'), trip);
      return { success: true, tripId: docRef.id, inviteCode };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }, [user]);

  // Join a trip with invite code
  const joinTrip = useCallback(async (inviteCode) => {
    if (!user) return { success: false, error: 'Not authenticated' };

    try {
      const q = query(
        collection(db, 'trips'),
        where('inviteCode', '==', inviteCode.toUpperCase())
      );
      
      const snapshot = await getDocs(q);
      
      if (snapshot.empty) {
        return { success: false, error: 'Invalid invite code' };
      }

      const tripDoc = snapshot.docs[0];
      const tripData = tripDoc.data();

      if (tripData.memberIds.includes(user.uid)) {
        return { success: false, error: 'You are already a member of this trip' };
      }

      await updateDoc(doc(db, 'trips', tripDoc.id), {
        memberIds: arrayUnion(user.uid),
        members: arrayUnion({
          uid: user.uid,
          email: user.email,
          displayName: user.displayName || user.email?.split('@')[0],
          photoURL: user.photoURL
        }),
        updatedAt: new Date().toISOString()
      });

      return { success: true, tripId: tripDoc.id, tripName: tripData.name };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }, [user]);

  // Leave a trip
  const leaveTrip = useCallback(async (tripId) => {
    if (!user) return { success: false, error: 'Not authenticated' };

    try {
      const tripRef = doc(db, 'trips', tripId);
      const tripSnap = await getDoc(tripRef);
      
      if (!tripSnap.exists()) {
        return { success: false, error: 'Trip not found' };
      }

      const tripData = tripSnap.data();
      const memberToRemove = tripData.members.find(m => m.uid === user.uid);

      if (tripData.createdBy === user.uid) {
        return { success: false, error: 'Creator cannot leave the trip. Delete it instead.' };
      }

      await updateDoc(tripRef, {
        memberIds: arrayRemove(user.uid),
        members: arrayRemove(memberToRemove),
        updatedAt: new Date().toISOString()
      });

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }, [user]);

  // Delete a trip
  const deleteTrip = useCallback(async (tripId) => {
    if (!user) return { success: false, error: 'Not authenticated' };

    try {
      const tripRef = doc(db, 'trips', tripId);
      const tripSnap = await getDoc(tripRef);
      
      if (!tripSnap.exists()) {
        return { success: false, error: 'Trip not found' };
      }

      if (tripSnap.data().createdBy !== user.uid) {
        return { success: false, error: 'Only the creator can delete this trip' };
      }

      await deleteDoc(tripRef);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }, [user]);

  // Add expense to trip
  const addExpense = useCallback(async (tripId, expenseData) => {
    if (!user) return { success: false, error: 'Not authenticated' };

    try {
      const tripRef = doc(db, 'trips', tripId);
      const expense = {
        id: Date.now().toString(),
        ...expenseData,
        paidBy: expenseData.paidBy || user.uid,
        createdBy: user.uid,
        createdAt: new Date().toISOString()
      };

      await updateDoc(tripRef, {
        expenses: arrayUnion(expense),
        updatedAt: new Date().toISOString()
      });

      return { success: true, expenseId: expense.id };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }, [user]);

  // Delete expense from trip
  const deleteExpense = useCallback(async (tripId, expense) => {
    if (!user) return { success: false, error: 'Not authenticated' };

    try {
      const tripRef = doc(db, 'trips', tripId);
      
      await updateDoc(tripRef, {
        expenses: arrayRemove(expense),
        updatedAt: new Date().toISOString()
      });

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }, [user]);

  // Calculate balances for a trip
  const calculateBalances = useCallback((trip) => {
    if (!trip || !trip.expenses || !trip.members) {
      return { balances: {}, settlements: [] };
    }

    const balances = {};
    
    // Initialize balances for all members
    trip.members.forEach(member => {
      balances[member.uid] = 0;
    });

    // Calculate net balance for each member
    trip.expenses.forEach(expense => {
      const amount = parseFloat(expense.amount);
      const paidBy = expense.paidBy;
      const splitBetween = expense.splitBetween || trip.memberIds;
      const splitAmount = amount / splitBetween.length;

      // Person who paid gets positive balance
      if (balances[paidBy] !== undefined) {
        balances[paidBy] += amount;
      }

      // People who owe get negative balance
      splitBetween.forEach(uid => {
        if (balances[uid] !== undefined) {
          balances[uid] -= splitAmount;
        }
      });
    });

    // Calculate settlements (who pays whom)
    const settlements = [];
    const debtors = [];
    const creditors = [];

    Object.entries(balances).forEach(([uid, balance]) => {
      if (balance < -0.01) {
        debtors.push({ uid, amount: -balance });
      } else if (balance > 0.01) {
        creditors.push({ uid, amount: balance });
      }
    });

    // Sort by amount
    debtors.sort((a, b) => b.amount - a.amount);
    creditors.sort((a, b) => b.amount - a.amount);

    // Match debtors with creditors
    let i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      const debtor = debtors[i];
      const creditor = creditors[j];
      
      const settleAmount = Math.min(debtor.amount, creditor.amount);
      
      if (settleAmount > 0.01) {
        settlements.push({
          from: debtor.uid,
          to: creditor.uid,
          amount: Math.round(settleAmount * 100) / 100
        });
      }

      debtor.amount -= settleAmount;
      creditor.amount -= settleAmount;

      if (debtor.amount < 0.01) i++;
      if (creditor.amount < 0.01) j++;
    }

    return { balances, settlements };
  }, []);

  const value = {
    trips,
    loading,
    createTrip,
    joinTrip,
    leaveTrip,
    deleteTrip,
    addExpense,
    deleteExpense,
    calculateBalances
  };

  return (
    <TripContext.Provider value={value}>
      {children}
    </TripContext.Provider>
  );
}


