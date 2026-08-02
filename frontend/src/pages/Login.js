import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { isHqHost, setHqBranch } from '../services/api';

// v1.5.1: HQ login no longer forces a branch pick. On the bare HQ host
// (sosnazm.com) the user just types email + password — authenticated
// against the default DB users table. After login, the sidebar's
// "Active Branch" dropdown still lets HQ admins drop into any branch's
// data when they need to.
const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();
  const hq = isHqHost();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      // Make sure no stale branch is attached to the login request — the
      // axios interceptor reads localStorage hq_branch and would otherwise
      // route auth/login into a per-branch DB.
      if (hq) setHqBranch('');
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <div className="login-logo"><img src="/sosna-logo.png" alt="Sosna" /></div>
          <h1>Sosna{hq ? ' HQ' : ''}</h1>
          <p>{hq ? 'Head Office' : 'Distribution Management'}</p>
        </div>
        {error && <div className="login-error">{error}</div>}
        <form className="login-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Username</label>
            <input type="text" value={email} onChange={e => setEmail(e.target.value)} placeholder="Enter your username" required />
          </div>
          <div className="form-group">
            <label>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter your password" required />
          </div>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default Login;
