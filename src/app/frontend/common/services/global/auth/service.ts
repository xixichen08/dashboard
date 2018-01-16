// Copyright 2017 The Kubernetes Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// import {stateName as errorState} from '../../error/state';
// import {stateName as loginState} from '../../login/state';
// import {stateName as overviewState} from '../../overview/state';
import {HttpClient, HttpHeaders} from '@angular/common/http';
import {Inject, Injectable} from '@angular/core';
import {AuthResponse, CsrfToken, LoginSpec, LoginStatus} from '@api/backendapi';
import {StateService, TransitionService} from '@uirouter/angular';
import {HookMatchCriteria, HookMatchCriterion, Transition} from '@uirouter/core';
import {CookieService} from 'ngx-cookie-service';
import {Observable} from 'rxjs/Observable';

import {aboutState} from '../../../../about/state';
import {CONFIG} from '../../../../index.config';
import {loginState} from '../../../../login/state';
import {CsrfTokenService} from '../csrftoken';

@Injectable()
export class AuthService {
  private readonly config_ = CONFIG;

  constructor(
      private cookies_: CookieService, private transitions_: TransitionService,
      private state_: StateService, private http_: HttpClient,
      private csrfTokenService_: CsrfTokenService) {}

  private setTokenCookie_(token: string) {
    // This will only work for HTTPS connection
    this.cookies_.set(this.config_.authTokenCookieName, token, null, null, null, true);
    // This will only work when accessing Dashboard at 'localhost' or '127.0.0.1'
    this.cookies_.set(this.config_.authTokenCookieName, token, null, null, 'localhost');
    this.cookies_.set(this.config_.authTokenCookieName, token, null, null, '127.0.0.1');
  }

  private getTokenCookie_(): string {
    return this.cookies_.get(this.config_.authTokenCookieName) || '';
  }

  private removeAuthCookies_() {
    this.cookies_.delete(this.config_.authTokenCookieName);
    this.cookies_.delete(this.config_.skipLoginPageCookieName);
  }

  /** Sends a login request to the backend with filled in login spec structure. */
  login(loginSpec: LoginSpec) {
    const loginObs =
        this.csrfTokenService_.getTokenForAction('login').switchMap<CsrfToken, AuthResponse>(
            csrfToken => {
              return this.http_.post<AuthResponse>(
                  'api/v1/login', loginSpec,
                  {headers: new HttpHeaders().set(this.config_.csrfHeaderName, csrfToken.token)});
            });

    return loginObs.subscribe(
        authResponse => {
          if (authResponse.jweToken.length !== 0 && authResponse.errors.length === 0) {
            this.setTokenCookie_(authResponse.jweToken);
          }

          return authResponse.errors;
        },
        err => {
          return Observable.throw(err);
        });
  }

  /** Cleans cookies and goes to login page. */
  logout() {
    this.removeAuthCookies_();
    this.state_.go(loginState);
  }

  /**
   * In order to determine if user is logged in one of below factors have to be fulfilled:
   *  - valid jwe token has to be present in a cookie (named 'kdToken')
   *  - authorization header has to be present in request to dashboard ('Authorization: Bearer
   * <token>')
   */
  redirectToLogin(transition: Transition) {
    const state = transition.router.stateService;
    this.getLoginStatus().subscribe(loginStatus => {
      console.log(loginStatus);
      console.log(transition.to().name);
      if (transition.to().name === loginState.name &&
          // Do not allow entering login page if already authenticated or authentication is
          // disabled.
          (this.isAuthenticated(loginStatus) || !this.isAuthenticationEnabled(loginStatus))) {
        // Todo change to overview state
        return state.target(aboutState);
      }

      // In following cases user should not be redirected and reach his target state:
      if (transition.to().name === loginState.name || transition.to().name === 'error' ||
          !this.isLoginPageEnabled() || !this.isAuthenticationEnabled(loginStatus) ||
          this.isAuthenticated(loginStatus)) {
        return;
      }

      // In other cases redirect user to login state.
      state.target(loginState.name);
    });
  }

  /**
   * Sends a token refresh request to the backend. In case user is not logged in with token nothing
   * will happen.
   */
  refreshToken() {
    const token = this.getTokenCookie_();
    if (token.length === 0) return;

    const tokenRefreshObs =
        this.csrfTokenService_.getTokenForAction('token').switchMap<CsrfToken, AuthResponse>(
            csrfToken => {
              return this.http_.post<AuthResponse>(
                  'api/v1/token/refresh', {jweToken: token},
                  {headers: new HttpHeaders().set(this.config_.csrfHeaderName, csrfToken.token)});
            });

    tokenRefreshObs.subscribe(
        authResponse => {
          if (authResponse.jweToken.length !== 0 && authResponse.errors.length === 0) {
            this.setTokenCookie_(authResponse.jweToken);
            return;
          }

          return Observable.throw(authResponse.errors);
        },
        err => {
          return Observable.throw(err);
        });
  }

  /** Checks if user is authenticated. */
  isAuthenticated(loginStatus: LoginStatus): boolean {
    return loginStatus.headerPresent || loginStatus.tokenPresent;
  }

  /**
   * Checks authentication is enabled. It is enabled only on HTTPS. Can be overridden by
   * 'enable-insecure-login' flag passed to dashboard.
   */
  isAuthenticationEnabled(loginStatus: LoginStatus): boolean {
    return loginStatus.httpsMode;
  }

  getLoginStatus(): Observable<LoginStatus> {
    const token = this.getTokenCookie_();
    return this.http_.get<LoginStatus>(
        'api/v1/login/status',
        {headers: new HttpHeaders().set(this.config_.authTokenHeaderName, token)});
  }

  skipLoginPage(skip: boolean) {
    this.removeAuthCookies_();
    this.cookies_.set(this.config_.skipLoginPageCookieName, skip.toString());
  }

  /**
   * Returns true if user has selected to skip page, false otherwise.
   * As cookie returns string or undefined we have to check for a string match.
   * In case cookie is not set login page will also be visible.
   */
  isLoginPageEnabled(): boolean {
    return !(this.cookies_.get(this.config_.skipLoginPageCookieName) === 'true');
  }

  /**
   * Initializes the service to track state changes and make sure that user is logged in and
   * token has not expired.
   */
  init() {
    const requiresAuthCriteria = {
      to: (state): HookMatchCriterion => state.data && state.data.requiresAuth
    } as HookMatchCriteria;

    this.transitions_.onBefore(requiresAuthCriteria, (transition) => {
      return this.redirectToLogin(transition);
    }, {priority: 10});

    this.transitions_.onBefore(requiresAuthCriteria, () => {
      return this.refreshToken();
    });
  }
}
