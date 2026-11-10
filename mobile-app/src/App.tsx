import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { IonApp, IonPage, IonContent, IonRouterOutlet } from "@ionic/react";
import { IonReactRouter } from "@ionic/react-router";
import { Redirect, Route } from "react-router-dom";
import { ThemeProvider } from "./state/theme";
import { AuthProvider, useAuth } from "./state/auth";
import { StudentProvider } from "./state/student";
import Shell from "./Shell";
import { hideSplash } from "./core/native";
import { Login, Signup, Forgot } from "./pages/auth/Auth";
import Home from "./pages/student/Home";
import Exams from "./pages/student/Exams";
import ExamDetail from "./pages/student/ExamDetail";
import Schedule from "./pages/student/Schedule";
import Results from "./pages/student/Results";
import Profile from "./pages/student/Profile";

// The heavier screens load only when opened (fast start on budget phones).
const ExamPlayer = lazy(() => import("./pages/student/ExamPlayer"));
const ExamResult = lazy(() => import("./pages/student/ExamResult"));
const Leaderboard = lazy(() => import("./pages/student/Leaderboard"));
const Performance = lazy(() => import("./pages/student/Performance"));
const Notifications = lazy(() => import("./pages/student/Notifications"));
const Categories = lazy(() => import("./pages/student/Categories"));
const Academic = lazy(() => import("./pages/student/Academic"));
const Settings = lazy(() => import("./pages/student/Settings"));
const EditProfile = lazy(() => import("./pages/student/EditProfile"));
const Info = lazy(() => import("./pages/student/Info"));
const AdminHome = lazy(() => import("./pages/admin/AdminHome"));
const AdminExams = lazy(() => import("./pages/admin/AdminExams"));
const AdminExamEditor = lazy(() => import("./pages/admin/AdminExamEditor"));
const AdminStudents = lazy(() => import("./pages/admin/AdminStudents"));
const AdminNotices = lazy(() => import("./pages/admin/AdminNotices"));
const AdminMore = lazy(() => import("./pages/admin/AdminMore"));
const AdminAdmins = lazy(() => import("./pages/admin/AdminAdmins"));
const AdminResults = lazy(() => import("./pages/admin/AdminResults"));
const AdminPush = lazy(() => import("./pages/admin/AdminPush"));
const AdminLogs = lazy(() => import("./pages/admin/AdminLogs"));

function Splash() {
  return <IonPage><IonContent><div style={{ height: "100%", display: "grid", placeItems: "center" }}><img src="/favicon.png" alt="" width={88} height={88} style={{ borderRadius: 24 }} /></div></IonContent></IonPage>;
}

/** Signed-in only. `admin` also needs the isAdmin flag — the real protection is firestore.rules; this just keeps students out of the screens. */
function Protected({ children, admin = false, perm }: { children: ReactNode; admin?: boolean; perm?: string }) {
  const { ready, user, isAdmin, can } = useAuth();
  if (!ready) return <Splash />;
  if (!user) return <Redirect to="/login" />;
  if ((admin || perm) && !isAdmin) return <Redirect to="/home" />;
  if (perm && !can(perm)) return <Redirect to="/admin" />;
  return <Suspense fallback={<Splash />}>{children}</Suspense>;
}
function Guest({ children }: { children: ReactNode }) {
  const { ready, user } = useAuth();
  if (!ready) return <Splash />;
  if (user) return <Redirect to="/home" />;
  return <>{children}</>;
}
function SplashGate() { const { ready } = useAuth(); useEffect(() => { if (ready) void hideSplash(); }, [ready]); return null; }

export default function App() {
  return (
    <IonApp>
      <ThemeProvider>
        <AuthProvider>
          <StudentProvider>
            <SplashGate />
            <IonReactRouter>
              <Shell>
                <IonRouterOutlet>
                  <Route exact path="/login"><Guest><Login /></Guest></Route>
                  <Route exact path="/signup"><Guest><Signup /></Guest></Route>
                  <Route exact path="/forgot"><Guest><Forgot /></Guest></Route>
                  <Route exact path="/home"><Protected><Home /></Protected></Route>
                  <Route exact path="/exams"><Protected><Exams /></Protected></Route>
                  <Route exact path="/exams/:id"><Protected><ExamDetail /></Protected></Route>
                  <Route exact path="/exams/:id/play"><Protected><ExamPlayer /></Protected></Route>
                  <Route exact path="/exams/:id/result"><Protected><ExamResult /></Protected></Route>
                  <Route exact path="/schedule"><Protected><Schedule /></Protected></Route>
                  <Route exact path="/results"><Protected><Results /></Protected></Route>
                  <Route exact path="/leaderboard"><Protected><Leaderboard /></Protected></Route>
                  <Route exact path="/performance"><Protected><Performance /></Protected></Route>
                  <Route exact path="/notifications"><Protected><Notifications /></Protected></Route>
                  <Route exact path="/categories"><Protected><Categories /></Protected></Route>
                  <Route exact path="/academic"><Protected><Academic /></Protected></Route>
                  <Route exact path="/profile"><Protected><Profile /></Protected></Route>
                  <Route exact path="/profile/edit"><Protected><EditProfile /></Protected></Route>
                  <Route exact path="/settings"><Protected><Settings /></Protected></Route>
                  <Route exact path="/info/:kind"><Suspense fallback={<Splash />}><Info /></Suspense></Route>
                  <Route exact path="/admin"><Protected admin><AdminHome /></Protected></Route>
                  <Route exact path="/admin/exams"><Protected perm="exams.view"><AdminExams /></Protected></Route>
                  <Route exact path="/admin/exams/new"><Protected perm="exams.write"><AdminExamEditor /></Protected></Route>
                  <Route exact path="/admin/exams/:id"><Protected perm="exams.write"><AdminExamEditor /></Protected></Route>
                  <Route exact path="/admin/students"><Protected perm="students.view"><AdminStudents /></Protected></Route>
                  <Route exact path="/admin/notices"><Protected perm="notices.manage"><AdminNotices /></Protected></Route>
                  <Route exact path="/admin/more"><Protected admin><AdminMore /></Protected></Route>
                  <Route exact path="/admin/admins"><Protected perm="admins.manage"><AdminAdmins /></Protected></Route>
                  <Route exact path="/admin/results"><Protected perm="results.view"><AdminResults /></Protected></Route>
                  <Route exact path="/admin/push"><Protected perm="push.manage"><AdminPush /></Protected></Route>
                  <Route exact path="/admin/logs"><Protected perm="logs.view"><AdminLogs /></Protected></Route>
                  <Route exact path="/"><Redirect to="/home" /></Route>
                </IonRouterOutlet>
              </Shell>
            </IonReactRouter>
          </StudentProvider>
        </AuthProvider>
      </ThemeProvider>
    </IonApp>
  );
}
